import { join } from "node:path";
import { Agent, type AgentMessage, type AgentTool, uuidv7 } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, TextContent } from "@earendil-works/pi-ai";
import { BudgetGuard } from "../budget.ts";
import { COMPACTION_SETTINGS } from "../compaction.ts";
import { createExecutionEnv } from "../env.ts";
import type { HookRunner } from "../hooks.ts";
import { TurnController } from "../loop/turn-controller.ts";
import { makeErrorAssistantMessage, runTurnWithTransientRetry, streamWithRetry } from "../retry.ts";
import { SUBAGENT_DEFAULT_WALL_CLOCK_MS } from "../timeouts.ts";
import { createBaseTools } from "../tools.ts";
import { loadProfiles, type Profile, resolveProfile } from "./profiles.ts";
import { createSpawnAgentTool, createSwarmTool } from "./tools.ts";

export { mapPooled } from "./pool.ts";

export const SUBAGENT_SYSTEM_PROMPT = [
	"You are a Kea subagent. The parent agent has not seen your context and will see only your final message; treat the parent as your caller, never the end user.",
	"",
	"Your final message is the entire handoff:",
	"- Answer the task first, then the evidence (file paths, numbers with units/seeds, verbatim quotes or DOIs).",
	"- Say what you checked and what you could not check; a one-sentence reply without evidence is a failure.",
	"",
	"Working rules:",
	"- Your permission scope is fixed; rejected operations cannot be widened — state the limitation instead of retrying.",
	"- You cannot ask questions; if the task is ambiguous, cover the most reasonable interpretation and flag it.",
	"- If a resource is unreachable or a check cannot be run, state that plainly — NEVER fabricate a result or a citation.",
	"- Prefer reading and searching over executing; if your role has no write tools, never attempt writes.",
	"- Stop when the evidence is sufficient.",
].join("\n");

function budgetNotice(maxTurns: number): string {
	return [
		`Budget: at most ${maxTurns} turns. Spend early turns on the highest-information lookups, and leave enough`,
		"turns to compose the final handoff. When the budget runs low, stop exploring and write up what you have.",
	].join(" ");
}

function profilePromptSuffix(profile: string): string {
	switch (profile) {
		case "reader":
			return [
				"Role: read-only investigator. You have no write or execute tools — never attempt to modify anything.",
				"Be fast: find, read, and report with exact references (paths, line numbers, DOIs).",
			].join(" ");
		case "writer":
			return [
				"Role: writer. You may create and edit files but you have no shell.",
				"Keep changes minimal and purpose-built; match surrounding conventions; list every file you touched in the handoff.",
			].join(" ");
		case "planner":
			return [
				"Role: planner. You may read and delegate to nested subagents, but you have no write or execute tools.",
				"Fan out independent research questions to subagents, then synthesize their findings into one plan.",
			].join(" ");
		default:
			return "Role: experimenter. You may read, write and execute. Every executed step belongs in the handoff with its outcome.";
	}
}

export interface SubagentRequest {
	task: string;
	context?: string;
	profile?: string;
	maxTurns?: number;
	depth?: number;
	parentId?: string;
	label?: string;
	onProgress?: (line: string) => void;
	signal?: AbortSignal;
}

export interface SubagentResult {
	id: string;
	profile: string;
	summary: string;
	turns: number;
	budgetExhausted: boolean;
	failed: boolean;
	error?: string;
}

export type SubagentOutcome = "completed" | "error" | "aborted";

export interface SubagentRunnerOptions {
	cwd: string;
	models: Models;
	maxDepth?: number;
	trusted?: boolean;
	extraTools?: AgentTool[];

	getModel: () => Model<Api>;
	/**
	 * parent kernel's tool gate: subagents must use the same permission path as the main loop, otherwise
	 * approving one spawn_agent in manual mode would release all of the subagent's write/execute operations.
	 */
	toolGate?: (ctx: {
		toolCall: { id: string; name: string };
		args: unknown;
	}) => Promise<{ block: boolean; reason: string } | undefined>;
	hooks?: HookRunner;
}

export function subagentsDir(cwd: string): string {
	return join(cwd, ".kea", "subagents");
}

export class SubagentRunner {
	private profiles: Map<string, Profile> | undefined;

	constructor(private readonly options: SubagentRunnerOptions) {}

	async listProfiles(): Promise<Map<string, Profile>> {
		this.profiles ??= await loadProfiles(this.options.cwd, { trusted: this.options.trusted });
		return this.profiles;
	}

	async run(request: SubagentRequest): Promise<SubagentResult> {
		const id = uuidv7();
		const labelPayload = request.label ? { label: request.label } : {};
		this.options.hooks?.fireAndForget("SubagentStart", { subagent_id: id, ...labelPayload });
		// SubagentStart already fired: every early-exit path must pair a SubagentStop(error) in the finally,
		// never leaving an orphan Start; stopFired prevents a double fire on the normal path
		let stopFired = false;
		try {
			const profiles = await this.listProfiles();
			const profile = resolveProfile(profiles, request.profile);

			const { env } = await createExecutionEnv(this.options.cwd);
			const depth = request.depth ?? 0;
			const maxDepth = this.options.maxDepth ?? 2;
			const tools: AgentTool[] = [
				...filterTools(createBaseTools(env), profile.tools),
				...(this.options.extraTools ?? []),
			];
			if (profile.spawn && depth < maxDepth) {
				tools.push(createSpawnAgentTool(this, depth + 1, id), createSwarmTool(this, depth + 1, id));
			}
			const maxTurns = request.maxTurns ?? profile.budget?.maxTurns ?? 20;
			const wallClockMs = profile.budget?.wallClockMs ?? SUBAGENT_DEFAULT_WALL_CLOCK_MS;

			const turnController = new TurnController({
				budget: new BudgetGuard({ iterations: maxTurns, wallClockMs }),
				compactionSettings: { ...COMPACTION_SETTINGS, enabled: false },
			});
			turnController.resetPrompt();

			const systemPrompt = [
				SUBAGENT_SYSTEM_PROMPT,
				budgetNotice(maxTurns),
				profilePromptSuffix(profile.name),
				...(profile.systemPromptExtra ? [profile.systemPromptExtra] : []),
				// JSON.stringify the dynamic values: delegator text must not break out of its labeled block
				...(request.context
					? [`Context from the delegating agent (JSON string):\n${JSON.stringify(request.context)}`]
					: []),
			].join("\n\n");

			const toolGate = this.options.toolGate;
			const agent = new Agent({
				initialState: { systemPrompt, model: this.options.getModel(), tools, thinkingLevel: "low" },
				sessionId: id,
				...(toolGate
					? { beforeToolCall: (ctx: { toolCall: { id: string; name: string }; args: unknown }) => toolGate(ctx) }
					: {}),
				streamFn: (m, context, opts) =>
					streamWithRetry(() => this.options.models.streamSimple(m, context, opts), {
						signal: opts?.signal,
						makeErrorMessage: (errorMessage) => makeErrorAssistantMessage(m, errorMessage),
					}),
				// two-stage budget: the first overrun injects a wrap-up steer so the subagent writes its handoff,
				// only the second overrun stops it
				shouldStopAfterTurn: (ctx) => {
					const decision = turnController.evaluateTurnEnd(ctx.context.messages);
					if (decision.steerText) {
						agent.steer({ role: "user", content: [{ type: "text", text: decision.steerText }], timestamp: Date.now() });
					}
					return decision.stop;
				},
			});

			let turns = 0;
			agent.subscribe((event) => {
				if (event.type === "turn_end") {
					turns += 1;
					request.onProgress?.(`Turn ${turns} complete`);
				}
			});

			const taskText = request.task;
			let failed = false;
			let error: string | undefined;
			const onAbort = () => agent.abort();
			request.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				if (request.signal?.aborted) throw new Error("aborted");
				const host = {
					prompt: (text: string) =>
						agent.prompt({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }),
					waitForIdle: () => agent.waitForIdle(),
					errorMessage: () => agent.state.errorMessage,
				};
				const outcome = await runTurnWithTransientRetry(host, taskText, { signal: request.signal });
				if (outcome.error) {
					failed = true;
					error = outcome.error;
				}
			} catch (err) {
				failed = true;
				error = err instanceof Error ? err.message : String(err);
			} finally {
				request.signal?.removeEventListener("abort", onAbort);
			}

			// mirror kernel computeRunOutcome: abort takes precedence over errorMessage; never misreport completed
			const aborted = lastAssistantStopReason(agent.state.messages) === "aborted" || error === "aborted";
			if (aborted) {
				failed = true;
				error = "aborted";
			}

			const summary = lastAssistantText(agent.state.messages);
			const result: SubagentResult = {
				id,
				profile: profile.name,
				summary: failed && !summary ? `subagent failed: ${error ?? "unknown"}` : summary,
				turns,
				budgetExhausted: turnController.budgetExhausted !== undefined,
				failed,
				error,
			};
			// settle before notify: fire the hook only once the outcome is final
			const outcome: SubagentOutcome = aborted ? "aborted" : failed ? "error" : "completed";
			this.options.hooks?.fireAndForget("SubagentStop", { subagent_id: id, outcome, ...labelPayload });
			stopFired = true;
			// persist failure must not turn a completed subagent into an error
			try {
				await this.persist(id, request, result);
			} catch (err) {
				console.error("[kea] subagent persist failed:", err);
			}
			return result;
		} finally {
			if (!stopFired) {
				this.options.hooks?.fireAndForget("SubagentStop", { subagent_id: id, outcome: "error", ...labelPayload });
			}
		}
	}

	async resume(id: string, followUp?: string): Promise<SubagentResult> {
		const record = await this.loadRecord(id);
		if (!record) throw new Error(`no subagent record ${id}`);
		return this.run({
			...record.request,
			task: followUp ?? record.request.task,
			// JSON.stringify the prior summary: a handoff containing template-breaking text must not escape its block
			context: [
				record.request.context ?? "",
				`Previous subagent run (${id}) concluded (JSON string):\n${JSON.stringify(record.result.summary)}`,
			]
				.filter(Boolean)
				.join("\n\n"),
		});
	}

	private async persist(id: string, request: SubagentRequest, result: SubagentResult): Promise<void> {
		const dir = subagentsDir(this.options.cwd);
		const { signal: _signal, onProgress: _onProgress, ...persistable } = request;
		await Bun.write(
			join(dir, `${id}.json`),
			JSON.stringify({ request: persistable, result, endedAt: Date.now() }, null, 2),
		);
	}

	private async loadRecord(id: string): Promise<{ request: SubagentRequest; result: SubagentResult } | undefined> {
		const file = Bun.file(join(subagentsDir(this.options.cwd), `${id}.json`));
		if (!(await file.exists())) return undefined;
		try {
			return (await file.json()) as { request: SubagentRequest; result: SubagentResult };
		} catch {
			return undefined;
		}
	}
}

function filterTools(tools: AgentTool[], whitelist?: string[]): AgentTool[] {
	if (!whitelist) return tools;
	const allowed = new Set(whitelist);
	return tools.filter((t) => allowed.has(t.name));
}

function lastAssistantText(messages: readonly AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		const text = m.content
			.filter((b): b is TextContent => b.type === "text")
			.map((b) => b.text)
			.join("");
		if (text.trim() !== "") return text;
	}
	return "";
}

function lastAssistantStopReason(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "assistant") return (m as { stopReason?: string }).stopReason;
	}
	return undefined;
}
