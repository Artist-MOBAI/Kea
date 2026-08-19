import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, test } from "vitest";
import { HookRunner } from "../src/hooks.ts";
import { BUILTIN_PROFILES, resolveProfile } from "../src/subagent/profiles.ts";
import { mapPooled, SUBAGENT_SYSTEM_PROMPT, SubagentRunner } from "../src/subagent/runner.ts";
import { clampSwarmConcurrency, createSpawnAgentTool, createSwarmTool } from "../src/subagent/tools.ts";
import {
	SUBAGENT_JUDGE_WALL_CLOCK_MS,
	SUBAGENT_PLANNER_WALL_CLOCK_MS,
	SUBAGENT_READER_WALL_CLOCK_MS,
	SUBAGENT_WRITER_WALL_CLOCK_MS,
} from "../src/timeouts.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

function setup(cwd: string) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const runner = new SubagentRunner({ cwd, models, getModel: () => faux.getModel() });
	return { faux, runner };
}

describe("SubagentRunner (M2)", () => {
	test("delegated task returns only the final summary", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-sub-"));
		const { faux, runner } = setup(workdir);
		faux.setResponses([fauxAssistantMessage("finding: lattice constant 5.43 Å (source: data/mp.json)")]);

		const result = await runner.run({ task: "check the lattice constant" });
		expect(result.failed).toBe(false);
		expect(result.summary).toContain("lattice constant");
		expect(result.id).toBeTruthy();

		const record = await Bun.file(join(workdir, ".kea", "subagents", `${result.id}.json`)).json();
		expect(record.request.task).toBe("check the lattice constant");
		expect(record.request.signal).toBeUndefined();
		expect(record.request.onProgress).toBeUndefined();
	}, 20_000);

	test("pre-aborted signal fails fast without starting a sub-run", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-sub-"));
		const { faux, runner } = setup(workdir);
		faux.setResponses([fauxAssistantMessage("should never be produced")]);

		const result = await runner.run({ task: "never runs", signal: AbortSignal.abort() });
		expect(result.failed).toBe(true);
		expect(result.error).toBe("aborted");
		expect(result.turns).toBe(0);
	}, 20_000);

	test("mid-stream socket drop retries the subagent turn with a continuation", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-sub-"));
		const { faux, runner } = setup(workdir);
		faux.setResponses([
			fauxAssistantMessage("partial work before disconnect", {
				stopReason: "error",
				errorMessage: "The socket connection was closed unexpectedly",
			}),
			fauxAssistantMessage("recovered final summary"),
		]);

		const result = await runner.run({ task: "keep going" });
		expect(result.failed).toBe(false);
		expect(result.summary).toContain("recovered final summary");
	}, 30_000);

	test("turn budget caps a tool-looping subagent", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-sub-"));
		const { faux, runner } = setup(workdir);

		faux.setResponses(
			Array.from({ length: 30 }, () => fauxAssistantMessage([fauxToolCall("bash", { command: "echo tick" })])),
		);

		const result = await runner.run({ task: "loop forever", maxTurns: 2 });
		expect(result.budgetExhausted).toBe(true);
		expect(result.turns).toBeLessThanOrEqual(3);
	}, 30_000);

	test("budget breach: wrap-up steer injected before stop (two-phase, same as kimi kernel)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-sub-"));
		const { faux, runner } = setup(workdir);
		// the 3rd response is context-sensitive: it returns the wrap-up handoff only if the [budget] steer marker reached it
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo 1" })]),
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo 2" })]),
			(context) => {
				const steered = context.messages.some((m) => {
					if (m.role !== "user" || !Array.isArray(m.content)) return false;
					return m.content.some((b) => "text" in b && typeof b.text === "string" && b.text.includes("[budget]"));
				});
				return fauxAssistantMessage(
					steered ? "wrap-up handoff: best result so far, remaining work listed" : "still exploring, no wrap-up",
				);
			},
		]);

		const result = await runner.run({ task: "loop until budget", maxTurns: 2 });
		expect(result.budgetExhausted).toBe(true);
		expect(result.turns).toBe(3); // budget 2 turns + 1 wrap-up turn earned by the wrap-up steer
		expect(result.summary).toContain("wrap-up handoff");
	}, 30_000);

	test("resume carries the previous summary as context", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-sub-"));
		const { faux, runner } = setup(workdir);
		faux.setResponses([fauxAssistantMessage("first-pass summary: gap identified")]);
		const first = await runner.run({ task: "survey thermoelectrics" });

		faux.appendResponses([fauxAssistantMessage("second pass built on prior context")]);
		const second = await runner.resume(first.id);
		expect(second.summary).toContain("second pass");
	}, 20_000);

	test("resolveProfile: builtins present, unknown throws with options", () => {
		const profiles = new Map(BUILTIN_PROFILES.map((p) => [p.name, p]));
		expect(resolveProfile(profiles).name).toBe("experimenter");
		expect(resolveProfile(profiles, "reader").tools).toContain("grep");
		expect(() => resolveProfile(profiles, "ghost")).toThrow(/experimenter, reader, writer/);
	});
});

describe("mapPooled (M2)", () => {
	test("runs all items with bounded concurrency, preserves order", async () => {
		let active = 0;
		let peak = 0;
		const results = await mapPooled([1, 2, 3, 4, 5, 6], 2, async (n) => {
			active += 1;
			peak = Math.max(peak, active);
			await Bun.sleep(5);
			active -= 1;
			return n * 10;
		});
		expect(results).toEqual([10, 20, 30, 40, 50, 60]);
		expect(peak).toBeLessThanOrEqual(2);
	});
});

describe("spawn_swarm tool contract", () => {
	test("template missing the {{item}} placeholder → throw (pi sets isError)", async () => {
		const tool = createSwarmTool({} as SubagentRunner);
		await expect(
			tool.execute("id", { prompt_template: "no placeholder", items: ["a"] }, undefined, undefined),
		).rejects.toThrow(/placeholder/);
	});

	test("abort mid-swarm: signal reaches every runner.run, remaining items never start (R4)", async () => {
		// hanging fake run: only if abort is forwarded to runner.run does execute reject promptly —
		// otherwise in-flight subagents orphan and keep burning budget
		let started = 0;
		const failed = {
			id: "x",
			profile: "experimenter",
			summary: "aborted",
			turns: 0,
			budgetExhausted: false,
			failed: true,
		};
		const orphanRunner = {
			run: (req: { task: string; signal?: AbortSignal }) =>
				new Promise<typeof failed>((resolve) => {
					started += 1;
					const signal = req.signal;
					if (!signal) return;
					if (signal.aborted) {
						resolve(failed);
						return;
					}
					signal.addEventListener("abort", () => resolve(failed), { once: true });
				}),
		} as unknown as SubagentRunner;

		const tool = createSwarmTool(orphanRunner);
		const controller = new AbortController();
		const pending = tool.execute(
			"id",
			{ prompt_template: "scan {{item}}", items: ["a", "b", "c"], max_concurrency: 1 },
			controller.signal,
			undefined,
		);
		await Bun.sleep(50);
		expect(started).toBe(1);
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(started).toBe(1);
	}, 10_000);

	test("pre-aborted signal: swarm rejects before any subagent runs (R4)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-sub-"));
		const { faux, runner } = setup(workdir);
		faux.setResponses([fauxAssistantMessage("should never run")]);
		const tool = createSwarmTool(runner);
		await expect(
			tool.execute("id", { prompt_template: "do {{item}}", items: ["a"] }, AbortSignal.abort(), undefined),
		).rejects.toThrow();
		expect(await Bun.file(join(workdir, ".kea", "subagents")).exists()).toBe(false);
	}, 20_000);

	test("mid-abort propagates into in-flight swarm subagents (real runner)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-sub-"));
		const { faux, runner } = setup(workdir);
		// Subagents keep looping the sleep tool: without forwarding signal, after abort they would still run all 20 sleeps
		faux.setResponses(
			Array.from({ length: 20 }, () => fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1" })])),
		);
		const tool = createSwarmTool(runner);
		const controller = new AbortController();
		const startedAt = Date.now();
		const pending = tool.execute(
			"id",
			{ prompt_template: "loop {{item}}", items: ["a", "b"], max_concurrency: 1 },
			controller.signal,
			undefined,
		);
		await Bun.sleep(700);
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(Date.now() - startedAt).toBeLessThan(15_000);
	}, 30_000);
});

describe("subagent permission gating (regression: spawn_agent bypassing approval)", () => {
	test("toolGate blocks: under manual semantics the subagent tool is denied and never executes", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-sub-gate-"));
		const marker = join(workdir, "pwned");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const runner = new SubagentRunner({
			cwd: workdir,
			models,
			getModel: () => faux.getModel(),
			toolGate: async () => ({ block: true, reason: "Denied by user (manual)" }),
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: `touch '${marker}'` })]),
			fauxAssistantMessage("handoff: nothing executed"),
		]);

		const result = await runner.run({ task: "touch the marker file" });
		expect(result.failed).toBe(false);
		expect(await Bun.file(marker).exists()).toBe(false);
	}, 20_000);

	test("toolGate allows: the tool executes normally", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-sub-gate2-"));
		const marker = join(workdir, "ran");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const runner = new SubagentRunner({
			cwd: workdir,
			models,
			getModel: () => faux.getModel(),
			toolGate: async () => undefined,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: `touch '${marker}'` })]),
			fauxAssistantMessage("handoff: executed"),
		]);

		const result = await runner.run({ task: "touch the marker file" });
		expect(result.failed).toBe(false);
		expect(await Bun.file(marker).exists()).toBe(true);
	}, 20_000);
});

describe("SubagentStart/SubagentStop hook pairing contract", () => {
	async function readLog(log: string): Promise<Array<Record<string, unknown>>> {
		if (!(await Bun.file(log).exists())) return [];
		const entries: Array<Record<string, unknown>> = [];
		for (const line of (await Bun.file(log).text()).split("\n")) {
			if (line.trim() === "") continue;
			try {
				entries.push(JSON.parse(line) as Record<string, unknown>);
			} catch {
				// Hit an in-flight half-written line; ignore
			}
		}
		return entries;
	}
	const byEvent = (entries: Array<Record<string, unknown>>, name: string) =>
		entries.filter((e) => e.hook_event_name === name);

	function setupWithHooks(cwd: string, log: string) {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const hooks = new HookRunner(
			{ hooks: { SubagentStart: [{ command: `cat >> '${log}'` }], SubagentStop: [{ command: `cat >> '${log}'` }] } },
			{ sessionId: () => "sess-sub", cwd, model: () => "faux/m1" },
		);
		const runner = new SubagentRunner({ cwd, models, getModel: () => faux.getModel(), hooks });
		return { faux, runner, hooks };
	}

	test("abort mid-run: outcome aborted (stopReason mirrored), Start/Stop paired exactly once", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-sub-abort-"));
		const log = join(workdir, "hooks.jsonl");
		const { faux, runner, hooks } = setupWithHooks(workdir, log);
		faux.setResponses(
			Array.from({ length: 20 }, () => fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1" })])),
		);

		const controller = new AbortController();
		const pending = runner.run({ task: "loop until aborted", signal: controller.signal });
		await Bun.sleep(700); // let the subagent enter the tool loop before abort (pi abort sets stopReason, not errorMessage)
		controller.abort();
		const result = await pending;

		expect(result.failed).toBe(true);
		expect(result.error).toBe("aborted");
		await hooks.flush();
		const entries = await readLog(log);
		const start = byEvent(entries, "SubagentStart")[0];
		const stops = byEvent(entries, "SubagentStop");
		expect(typeof start?.subagent_id).toBe("string");
		expect(stops).toHaveLength(1);
		expect(stops[0]?.subagent_id).toBe(start?.subagent_id);
		expect(stops[0]?.outcome).toBe("aborted");
	}, 30_000);

	test("early setup failure: Start is always paired with Stop(outcome error), no orphan Starts", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-sub-early-"));
		const log = join(workdir, "hooks.jsonl");
		const { runner, hooks } = setupWithHooks(workdir, log);
		// unknown profile throws after Start is emitted but before the agent is built — the early-exit path
		await expect(runner.run({ task: "never starts", profile: "ghost" })).rejects.toThrow(/unknown profile/);
		await hooks.flush();
		const entries = await readLog(log);
		const starts = byEvent(entries, "SubagentStart");
		const stops = byEvent(entries, "SubagentStop");
		expect(starts).toHaveLength(1);
		expect(stops).toHaveLength(1);
		expect(stops[0]?.subagent_id).toBe(starts[0]?.subagent_id);
		expect(stops[0]?.outcome).toBe("error");
	}, 20_000);
});

describe("nested delegation (depth propagation + planner profile)", () => {
	test("createSpawnAgentTool / createSwarmTool pass childDepth and parentId to runner.run", async () => {
		const seen: Array<{ depth: number; parentId?: string }> = [];
		const fakeRunner = {
			run: async (req: { task: string; depth?: number; parentId?: string }) => {
				seen.push({ depth: req.depth ?? 0, parentId: req.parentId });
				return { id: "x", profile: "experimenter", summary: "ok", turns: 1, budgetExhausted: false, failed: false };
			},
		} as unknown as SubagentRunner;

		await createSpawnAgentTool(fakeRunner, 3, "parent-1").execute("id", { task: "nested" }, undefined, undefined);
		await createSwarmTool(fakeRunner, 4, "parent-2").execute(
			"id",
			{ prompt_template: "do {{item}}", items: ["a"] },
			undefined,
			undefined,
		);
		expect(seen).toEqual([
			{ depth: 3, parentId: "parent-1" },
			{ depth: 4, parentId: "parent-2" },
		]);
	});

	test("resolveProfile: the built-in planner profile carries the spawn flag + reader tools", () => {
		const profiles = new Map(BUILTIN_PROFILES.map((p) => [p.name, p]));
		const planner = resolveProfile(profiles, "planner");
		expect(planner.spawn).toBe(true);
		expect(planner.tools).toContain("read");
		expect(planner.tools).not.toContain("write");
	});

	test("planner/judge/reader whitelists exclude science_plan (subagents cannot re-trigger orchestration)", () => {
		const profiles = new Map(BUILTIN_PROFILES.map((p) => [p.name, p]));
		for (const name of ["planner", "judge", "reader"] as const) {
			const profile = resolveProfile(profiles, name);
			expect(profile.tools, name).not.toContain("science_plan");
			expect(profile.tools, name).not.toContain("submit_science_plan");
		}
	});

	test("built-in profile wall-clock budgets come from the timeouts table (no hardcoded literals)", () => {
		const byName = new Map(BUILTIN_PROFILES.map((p) => [p.name, p]));
		expect(byName.get("reader")?.budget?.wallClockMs).toBe(SUBAGENT_READER_WALL_CLOCK_MS);
		expect(byName.get("writer")?.budget?.wallClockMs).toBe(SUBAGENT_WRITER_WALL_CLOCK_MS);
		expect(byName.get("planner")?.budget?.wallClockMs).toBe(SUBAGENT_PLANNER_WALL_CLOCK_MS);
		expect(byName.get("judge")?.budget?.wallClockMs).toBe(SUBAGENT_JUDGE_WALL_CLOCK_MS);
		// experimenter carries no budget: the runner falls back to SUBAGENT_DEFAULT_WALL_CLOCK_MS
		expect(byName.get("experimenter")?.budget).toBeUndefined();
	});
});

describe("spawn_swarm bounds: over-limit throws, profile passthrough, concurrency clamping (E2/E9/E10)", () => {
	const okResult = (profile?: string) => ({
		id: "x",
		profile: profile ?? "experimenter",
		summary: "ok",
		turns: 1,
		budgetExhausted: false,
		failed: false,
	});

	function recordingRunner(capture: Array<Record<string, unknown>>, delayMs = 0) {
		return {
			run: async (req: { task: string; profile?: string }) => {
				capture.push({ task: req.task, profile: req.profile });
				if (delayMs > 0) await Bun.sleep(delayMs);
				return okResult(req.profile);
			},
		} as unknown as SubagentRunner;
	}

	function items(n: number): string[] {
		return Array.from({ length: n }, (_, i) => `item-${i}`);
	}

	test("33 items → throw (message carries count and limit, no silent truncation); 32 items run normally", async () => {
		const capture: Array<Record<string, unknown>> = [];
		const tool = createSwarmTool(recordingRunner(capture));
		await expect(
			tool.execute("id", { prompt_template: "do {{item}}", items: items(33) }, undefined, undefined),
		).rejects.toThrow(/received 33 items, above the limit of 32/);
		expect(capture).toEqual([]); // nothing started

		const res = await tool.execute("id", { prompt_template: "do {{item}}", items: items(32) }, undefined, undefined);
		expect(res.details.count).toBe(32);
		expect(capture).toHaveLength(32);
	}, 15_000);

	test("profile is passed through to every worker; omitted by default (experimenter stays as-is)", async () => {
		const capture: Array<Record<string, unknown>> = [];
		const tool = createSwarmTool(recordingRunner(capture));
		await tool.execute(
			"id",
			{ prompt_template: "scan {{item}}", items: ["a", "b"], profile: "reader" },
			undefined,
			undefined,
		);
		expect(capture.map((c) => c.profile)).toEqual(["reader", "reader"]);

		const capture2: Array<Record<string, unknown>> = [];
		const tool2 = createSwarmTool(recordingRunner(capture2));
		await tool2.execute("id", { prompt_template: "scan {{item}}", items: ["a"] }, undefined, undefined);
		expect(capture2.map((c) => c.profile)).toEqual([undefined]);
	}, 15_000);

	test("clampSwarmConcurrency: default 4, floor 1, hard cap 8, narrowed by items", () => {
		expect(clampSwarmConcurrency(undefined, 10)).toBe(4);
		expect(clampSwarmConcurrency(2, 10)).toBe(2);
		expect(clampSwarmConcurrency(0, 5)).toBe(1);
		expect(clampSwarmConcurrency(-3, 5)).toBe(1);
		expect(clampSwarmConcurrency(8, 10)).toBe(8);
		expect(clampSwarmConcurrency(1000, 10)).toBe(8);
		expect(clampSwarmConcurrency(1000, 3)).toBe(3);
	});

	test("max_concurrency=1000 → actual concurrency peak is exactly 8, returned text notes the clamp", async () => {
		let active = 0;
		let peak = 0;
		const runner = {
			run: async (req: { profile?: string }) => {
				active += 1;
				peak = Math.max(peak, active);
				await Bun.sleep(30);
				active -= 1;
				return okResult(req.profile);
			},
		} as unknown as SubagentRunner;
		const res = await createSwarmTool(runner).execute(
			"id",
			{ prompt_template: "do {{item}}", items: items(20), max_concurrency: 1000 },
			undefined,
			undefined,
		);
		expect(peak).toBe(8);
		const text = (res.content as Array<{ type: string; text: string }>)
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		expect(text).toContain("note: max_concurrency clamped to 8");
	}, 15_000);

	test("max_concurrency within the cap → no clamp note", async () => {
		const capture: Array<Record<string, unknown>> = [];
		const res = await createSwarmTool(recordingRunner(capture)).execute(
			"id",
			{ prompt_template: "do {{item}}", items: ["a"], max_concurrency: 2 },
			undefined,
			undefined,
		);
		const text = (res.content as Array<{ type: string; text: string }>)
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		expect(text).not.toContain("clamped");
	}, 15_000);
});

describe("SUBAGENT_SYSTEM_PROMPT wording pin (stable model-visible text, DSH discipline)", () => {
	test("anti-fabrication and handoff contract lines kept verbatim", () => {
		expect(SUBAGENT_SYSTEM_PROMPT).toContain("will see only your final message");
		expect(SUBAGENT_SYSTEM_PROMPT).toContain("treat the parent as your caller, never the end user");
		expect(SUBAGENT_SYSTEM_PROMPT).toContain("Your final message is the entire handoff:");
		expect(SUBAGENT_SYSTEM_PROMPT).toContain("a one-sentence reply without evidence is a failure");
		expect(SUBAGENT_SYSTEM_PROMPT).toContain("NEVER fabricate a result or a citation.");
		expect(SUBAGENT_SYSTEM_PROMPT).toContain("state the limitation instead of retrying");
	});
});

describe("spawn tool prompt contract (F3/F4, 2026-08-15 prompt audit)", () => {
	const dummyRunner = { run: async () => ({}) } as unknown as Parameters<typeof createSpawnAgentTool>[0];

	test("profile list from BUILTIN_PROFILES: planner/judge in both tools' parameter descriptions (F3)", () => {
		const expected = BUILTIN_PROFILES.map((p) => p.name).join(" | ");
		for (const tool of [createSpawnAgentTool(dummyRunner), createSwarmTool(dummyRunner)]) {
			const params = JSON.stringify(tool.parameters);
			expect(params).toContain(expected);
			expect(params).toContain("planner");
			expect(params).toContain("judge");
		}
	});

	test("spawn_agent description carries the verify-first-then-delegate guard (F4, anti-hallucination)", () => {
		const description = createSpawnAgentTool(dummyRunner).description;
		expect(description).toContain("must come from your own tools");
		expect(description).toContain("find them first, then write them into the prompt");
	});

	test("spawn_agent description uses objective as the semantic noun (J6: mobai is a mode name only)", () => {
		const description = createSpawnAgentTool(dummyRunner).description;
		expect(description).toContain("Give the objective, not prescribed steps.");
		expect(description).not.toContain("mobai");
	});

	test("spawn tool description determinism (F7): same-args builds are identical (prefix-cache invariant)", () => {
		const a = createSpawnAgentTool(dummyRunner);
		const b = createSpawnAgentTool(dummyRunner);
		expect(a.description).toBe(b.description);
		expect(JSON.stringify(a.parameters)).toBe(JSON.stringify(b.parameters));
	});
});
