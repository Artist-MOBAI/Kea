import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { asTool } from "../tools.ts";
import { mapPooled } from "./pool.ts";
import { BUILTIN_PROFILES } from "./profiles.ts";
import type { SubagentRunner } from "./runner.ts";

const MAX_SWARM_ITEMS = 32;
const DEFAULT_SWARM_CONCURRENCY = 4;
const MAX_SWARM_CONCURRENCY = 8;

const PROFILE_NAMES = BUILTIN_PROFILES.map((p) => p.name).join(" | ");

export function clampSwarmConcurrency(requested: number | undefined, itemCount: number): number {
	return Math.min(Math.max(1, requested ?? DEFAULT_SWARM_CONCURRENCY), MAX_SWARM_CONCURRENCY, itemCount);
}

const spawnAgentParameters = z.strictObject({
	task: z.string().meta({ description: "Self-contained task description for the subagent" }),
	context: z.string().optional().meta({ description: "Background context the subagent needs" }),
	profile: z
		.string()
		.optional()
		.meta({ description: `Role profile: ${PROFILE_NAMES} | <custom> (default experimenter)` }),
	max_turns: z.number().optional().meta({ description: "Turn budget override" }),
});

export function createSpawnAgentTool(runner: SubagentRunner, childDepth = 0, parentId?: string): AgentTool {
	return asTool({
		name: "spawn_agent",
		label: "Spawn subagent",
		description: [
			"Delegate a bounded, self-contained task to a subagent running in its own isolated context.",
			"The subagent has NOT seen this conversation — brief it like a colleague who just walked in: the exact question, exact paths/queries, and constraints.",
			"Paths, line numbers, and identifiers you cite must come from your own tools — find them first, then write them into the prompt.",
			"Give the objective, not prescribed steps.",
			"You receive ONLY its final message, so ask for concrete evidence (paths, numbers, DOIs).",
			"When NOT to delegate: work you can finish in a few tool calls yourself, or tasks that need your live context.",
			"While a subagent runs, do not redo its work in parallel.",
		].join("\n"),
		parameters: z.toJSONSchema(spawnAgentParameters),
		executionMode: "sequential",
		async execute(
			_id: string,
			params: z.input<typeof spawnAgentParameters>,
			signal?: AbortSignal,
			onUpdate?: (partialResult: unknown) => void,
		) {
			const result = await runner.run({
				task: params.task,
				context: params.context,
				profile: params.profile,
				maxTurns: params.max_turns,
				depth: childDepth,
				parentId,
				signal,
				onProgress: (line) =>
					onUpdate?.({ content: [{ type: "text", text: `${line}\n` }], details: { id: "", failed: false } }),
			});
			const status = result.failed
				? `FAILED${result.error ? ` (${result.error})` : ""}`
				: result.budgetExhausted
					? "completed (budget exhausted)"
					: "completed";
			const text = [
				`### subagent ${result.id} [${status}, ${result.turns} turns, profile=${result.profile}]`,
				result.summary,
			].join("\n");
			return { content: [{ type: "text", text }], details: { id: result.id, failed: result.failed } };
		},
	});
}

const swarmParameters = z.strictObject({
	prompt_template: z.string().meta({ description: "Task template containing the {{item}} placeholder" }),
	items: z.array(z.string()).meta({
		description: `Values substituted into {{item}} (at most ${MAX_SWARM_ITEMS} per call; larger batches throw — split them)`,
	}),
	max_concurrency: z
		.number()
		.optional()
		.meta({
			description: `Parallel workers (default ${DEFAULT_SWARM_CONCURRENCY}, hard cap ${MAX_SWARM_CONCURRENCY})`,
		}),
	profile: z
		.string()
		.optional()
		.meta({
			description: `Role profile for every worker: ${PROFILE_NAMES} | <custom> (default experimenter). reader fits literature/file scans`,
		}),
});

export function createSwarmTool(runner: SubagentRunner, childDepth = 0, parentId?: string): AgentTool {
	return asTool({
		name: "spawn_swarm",
		label: "Spawn swarm",
		description: [
			"Fan out one identical subagent task per item — for homogeneous batches: per-paper literature scans, per-candidate checks, per-file audits.",
			"Each item becomes an independent subagent; results come back grouped by item.",
			"The prompt_template MUST contain the {{item}} placeholder and must stand alone without this conversation's context.",
			"Do not overload the template: one clear question per item.",
			"For heterogeneous work, use spawn_agent separately instead.",
		].join("\n"),
		parameters: z.toJSONSchema(swarmParameters),
		executionMode: "sequential",
		async execute(
			_id: string,
			params: z.input<typeof swarmParameters>,
			signal?: AbortSignal,
			onUpdate?: (partialResult: unknown) => void,
		) {
			if (!params.prompt_template.includes("{{item}}")) {
				// pi tool error semantics: error branches always throw (returning isError is dropped by the framework)
				throw new Error("prompt_template must contain the {{item}} placeholder.");
			}
			// over-limit batches throw instead of silently truncating: a truncated batch loses work invisibly
			if (params.items.length > MAX_SWARM_ITEMS) {
				throw new Error(
					`spawn_swarm received ${params.items.length} items, above the limit of ${MAX_SWARM_ITEMS}. Split the batch into multiple spawn_swarm calls.`,
				);
			}
			const items = params.items;
			const concurrency = clampSwarmConcurrency(params.max_concurrency, items.length);
			const total = items.length;
			let done = 0;
			const results = await mapPooled(
				items,
				concurrency,
				async (item) => {
					// the signal must be passed into every sub-run: otherwise in-flight swarm subagents become orphans
					// after the parent aborts and keep burning budget until they finish on their own
					const result = await runner.run({
						task: params.prompt_template.replaceAll("{{item}}", item),
						profile: params.profile,
						depth: childDepth,
						parentId,
						signal,
					});
					done += 1;
					const mark = result.failed ? "✗" : "✓";
					onUpdate?.({
						content: [{ type: "text", text: `${mark} [${done}/${total}] ${item} (${result.turns} turns)\n` }],
						details: { count: done, failed: result.failed ? 1 : 0 },
					});
					return result;
				},
				signal,
			);
			const sections = results.map((r, i) => {
				const status = r.failed ? "FAILED" : r.budgetExhausted ? "budget exhausted" : "ok";
				return `### ${items[i]} [${status}, ${r.turns} turns]\n${r.summary}`;
			});
			const clampedNote =
				params.max_concurrency !== undefined && params.max_concurrency > MAX_SWARM_CONCURRENCY
					? `\n\nnote: max_concurrency clamped to ${MAX_SWARM_CONCURRENCY}`
					: "";
			return {
				content: [{ type: "text", text: `${sections.join("\n\n")}${clampedNote}` }],
				details: { count: results.length, failed: results.filter((r) => r.failed).length },
			};
		},
	});
}
