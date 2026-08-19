import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionEnv, MemoryStore, type SubagentRunner } from "@kea/core";
import { afterAll, describe, expect, test } from "vitest";
import { Journal } from "../src/journal.ts";
import { loadMobai, loadMobaiIn, mobaiPathIn, saveMobai, saveMobaiIn } from "../src/mobai.ts";
import { saveProgram } from "../src/program/store.ts";
import { createProgramTools } from "../src/program-tools.ts";
import { createResearchTools } from "../src/tools.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

async function makeTools(subagents?: () => SubagentRunner | undefined) {
	workdir = await mkdtemp(join(tmpdir(), "kea2-mobaitools-"));
	const { env } = await createExecutionEnv(workdir);
	const tools = createResearchTools({
		cwd: workdir,
		env,
		models: undefined as never,
		getModel: () => {
			throw new Error("no model in this test");
		},
		journal: new Journal(workdir),
		memory: new MemoryStore(workdir),
		...(subagents ? { subagents } : {}),
	});
	const byName = (name: string) => {
		const tool = tools.find((t) => t.name === name);
		if (!tool) throw new Error(`tool not found: ${name}`);
		return tool as { name: string; execute: (id: string, params: unknown) => Promise<unknown> };
	};
	return { workdir, byName };
}

const criterion = { check: "file_exists" as const, description: "marker exists", path: "marker.txt" };

const fidelityRunner = (summary: string, failed = false) =>
	({ run: async () => ({ summary, failed }) }) as unknown as SubagentRunner;

describe("start_goal formalization fidelity (semantic judge replaces keyword gates; fail-open without a judge)", () => {
	test("objective with undecidability-level math content → admitted (no judge present still admits it)", async () => {
		const { byName } = await makeTools();
		await expect(
			byName("start_goal").execute("t1", {
				objective: "formalize the undecidability of the word problem for groups",
				criteria: [criterion],
			}),
		).resolves.toBeTruthy();
	});

	test("objective with honest-limit phrasing but no abandonment → admitted (prose is never engine input)", async () => {
		const { byName } = await makeTools();
		await expect(
			byName("start_goal").execute("t2", {
				// cjk-fixture: CJK honest-boundary objective without abandonment semantics must be admitted
				objective: "推进 RH，但诚实边界：不声称能证明它",
				criteria: [criterion],
			}),
		).resolves.toBeTruthy();
	});

	test("fidelity judge faithful=false → refused, shrinkment reason given (goal-lowering in any wording)", async () => {
		const runner = fidelityRunner(
			'{"faithful": false, "shrinkment": "a literature survey replaces the proof obligation"}',
		);
		const { byName } = await makeTools(() => runner);
		await expect(
			byName("start_goal").execute("t3", {
				objective: "let's just give up and lower the target to a literature survey",
				criteria: [criterion],
			}),
		).rejects.toThrow(/shrink the objective.*literature survey replaces the proof obligation/s);
	});

	test("verdicts faithful=true / unparsable / failed → all admitted (judge never blocks formalization)", async () => {
		const ok = await makeTools(() => fidelityRunner('{"faithful": true}'));
		await expect(
			ok.byName("start_goal").execute("t4", { objective: "prove the bound", criteria: [criterion] }),
		).resolves.toBeTruthy();
		const unparsable = await makeTools(() => fidelityRunner("could not produce JSON, sorry"));
		await expect(
			unparsable.byName("start_goal").execute("t5", { objective: "prove the bound", criteria: [criterion] }),
		).resolves.toBeTruthy();
		const failed = await makeTools(() => fidelityRunner("", true));
		await expect(
			failed.byName("start_goal").execute("t6", { objective: "prove the bound", criteria: [criterion] }),
		).resolves.toBeTruthy();
	});

	test("normal objective + frontier kind/recovery → persisted", async () => {
		const { byName, workdir: dir } = await makeTools();
		await byName("start_goal").execute("t3", {
			objective: "prove the bound",
			criteria: [criterion],
			frontier: [
				{
					id: "att-1",
					description: "direct attack",
					falsification_criterion: "counterexample below N=100",
				},
				{
					id: "ins-1",
					kind: "instrument",
					description: "comparison language",
					falsification_criterion: "fails to recover the classical case",
					recovery: "recovers the classical case at trivial parameter",
				},
			],
		});
		const mobai = await loadMobai(dir);
		expect(mobai?.frontier.find((p) => p.id === "att-1")?.kind).toBe("attack");
		expect(mobai?.frontier.find((p) => p.id === "ins-1")?.recovery).toContain("recovers");
	});

	test("instrument without recovery → refused (schema admission)", async () => {
		const { byName } = await makeTools();
		await expect(
			byName("start_goal").execute("t4", {
				objective: "prove the bound",
				criteria: [criterion],
				frontier: [
					{
						id: "ins-2",
						kind: "instrument",
						description: "new language",
						falsification_criterion: "f",
					},
				],
			}),
		).rejects.toThrow(/recovery/);
	});

	test("start_goal refused while an active mobai exists (completion gate immutable, PlanGuard)", async () => {
		const { byName, workdir: dir } = await makeTools();
		await saveMobai(dir, {
			objective: "x",
			criteria: [criterion],
			status: "active",
			updatedAt: Date.now(),
			frontier: [],
			progress: [],
		});
		await expect(byName("start_goal").execute("t10", { objective: "y", criteria: [criterion] })).rejects.toThrow(
			/immutable/,
		);
		// after complete, formalizing a new objective is allowed
		const done = await Bun.file(join(dir, ".kea", "mobai.json")).json();
		await Bun.write(join(dir, ".kea", "mobai.json"), JSON.stringify({ ...done, status: "complete" }));
		await expect(byName("start_goal").execute("t11", { objective: "y", criteria: [criterion] })).resolves.toBeTruthy();
	});
});

describe("update_goal blocked refusal (attacksClosed means a new instrument, not stopping)", () => {
	test("blocked is refused when all attacks are closed", async () => {
		const { byName, workdir: dir } = await makeTools();
		await saveMobai(dir, {
			objective: "x",
			criteria: [criterion],
			status: "active",
			updatedAt: Date.now(),
			frontier: [{ id: "a", description: "d", falsification_criterion: "f", kind: "attack", status: "refuted" }],
			progress: [],
		});
		await expect(
			byName("update_goal").execute("t5", {
				status: "blocked",
				blockedReason: { kind: "external_dependency", detail: "needs a new mathematics" },
			}),
		).rejects.toThrow(/new instrument is needed/);
	});

	test("blocked is writable while an open attack remains (genuine external-blockage path)", async () => {
		const { byName, workdir: dir } = await makeTools();
		await saveMobai(dir, {
			objective: "x",
			criteria: [criterion],
			status: "active",
			updatedAt: Date.now(),
			frontier: [{ id: "a", description: "d", falsification_criterion: "f", kind: "attack", status: "open" }],
			progress: [],
		});
		await byName("update_goal").execute("t6", {
			status: "blocked",
			blockedReason: { kind: "missing_credential", detail: "no API key for dataset" },
		});
		const mobai = await loadMobai(dir);
		expect(mobai?.status).toBe("blocked");
		expect(mobai?.blockedReason?.kind).toBe("missing_credential");
	});
});

describe("log_progress newPaths (sea writes back to the ledger)", () => {
	test("appends obstruction/translation/instrument/attack entries and keeps progress", async () => {
		const { byName, workdir: dir } = await makeTools();
		await saveMobai(dir, {
			objective: "x",
			criteria: [criterion],
			status: "active",
			updatedAt: Date.now(),
			frontier: [{ id: "a1", description: "d", falsification_criterion: "f", kind: "attack", status: "refuted" }],
			progress: [],
		});
		await byName("log_progress").execute("t7", {
			kind: "tool",
			description: "opened a new line via a fresh strategist",
			evidence: "subagent run mobai-sea; see .kea/subagents/",
			round: 3,
			newPaths: [
				{
					id: "obs-1",
					kind: "obstruction",
					description: "rank inequality blocks the unconditional quadratic form",
					falsification_criterion: "obstruction stated but not checkable",
				},
				{
					id: "tr-1",
					kind: "translation",
					description: "restate zeros as a forbidden object in an L-function category",
					falsification_criterion: "translation loses the original statement",
				},
				{
					id: "att-2",
					kind: "attack",
					description: "attack via the translated object only",
					falsification_criterion: "translated object fails to recover known cases",
				},
			],
		});
		const mobai = await loadMobai(dir);
		expect(mobai?.frontier.map((p) => p.id)).toEqual(["a1", "obs-1", "tr-1", "att-2"]);
		expect(mobai?.frontier.find((p) => p.id === "att-2")?.status).toBe("open");
		expect(mobai?.progress).toHaveLength(1);
	});

	test("duplicate id refused; instrument without recovery refused", async () => {
		const { byName, workdir: dir } = await makeTools();
		await saveMobai(dir, {
			objective: "x",
			criteria: [criterion],
			status: "active",
			updatedAt: Date.now(),
			frontier: [{ id: "dup", description: "d", falsification_criterion: "f", kind: "attack", status: "open" }],
			progress: [],
		});
		await expect(
			byName("log_progress").execute("t8", {
				kind: "artifact",
				description: "x",
				evidence: "y",
				newPaths: [{ id: "dup", kind: "attack", description: "d2", falsification_criterion: "f" }],
			}),
		).rejects.toThrow(/already exists/);
		await expect(
			byName("log_progress").execute("t9", {
				kind: "artifact",
				description: "x",
				evidence: "y",
				newPaths: [{ id: "ins-9", kind: "instrument", description: "d", falsification_criterion: "f" }],
			}),
		).rejects.toThrow(/recovery/);
	});
});

describe("mobaiDir session-level isolation (TUI session-scoped mobai)", () => {
	test("the mobaiDir getter makes start_goal write the session dir, not the workspace .kea", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-mobaidir-"));
		const sessionDir = join(workdir, ".kea", "mobai", "s1");
		const { env } = await createExecutionEnv(workdir);
		const tools = createResearchTools({
			cwd: workdir,
			env,
			models: undefined as never,
			getModel: () => {
				throw new Error("no model in this test");
			},
			journal: new Journal(workdir),
			memory: new MemoryStore(workdir),
			mobaiDir: () => sessionDir,
		});
		const start = tools.find((t) => t.name === "start_goal") as unknown as {
			execute: (id: string, params: unknown) => Promise<unknown>;
		};
		await start.execute("t1", { objective: "session mobai", criteria: [criterion], frontier: [] });

		expect(await loadMobai(workdir)).toBeUndefined(); // workspace mobai untouched
		expect((await loadMobaiIn(sessionDir))?.objective).toBe("session mobai");
		expect(mobaiPathIn(sessionDir)).toContain(join(".kea", "mobai", "s1", "mobai.json"));
	});

	test("distinct session dirs do not conflict", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-mobaidir-"));
		const a = join(workdir, ".kea", "mobai", "s-a");
		const b = join(workdir, ".kea", "mobai", "s-b");
		const mobai = (objective: string) => ({
			objective,
			criteria: [criterion],
			status: "active" as const,
			updatedAt: Date.now(),
			frontier: [],
			progress: [],
		});
		await saveMobaiIn(a, mobai("a"));
		await saveMobaiIn(b, mobai("b"));
		expect((await loadMobaiIn(a))?.objective).toBe("a");
		expect((await loadMobaiIn(b))?.objective).toBe("b");
	});
});

describe("research tool description contract lines (three-section style, wording is the contract)", () => {
	test("machine semantics and dedup/escalation paths of key tools pinned verbatim", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kea2-mobaitools-desc-"));
		const { env } = await createExecutionEnv(dir);
		const tools = createResearchTools({
			cwd: dir,
			env,
			models: undefined as never,
			getModel: () => {
				throw new Error("no model in this test");
			},
			journal: new Journal(dir),
			memory: new MemoryStore(dir),
		});
		const desc = (name: string) => {
			const tool = tools.find((t) => t.name === name);
			if (!tool) throw new Error(`tool not found: ${name}`);
			return tool.description;
		};
		expect(desc("check_goal")).toContain("ONLY path that sets 'complete'");
		expect(desc("check_goal")).toContain("rolled back to active");
		expect(desc("start_goal")).toContain("criteria are immutable");
		expect(desc("start_goal")).toContain("ONLY by check_goal");
		expect(desc("start_goal")).toContain("fresh-context reviewer verifies the formalization");
		expect(desc("update_goal")).toContain("NEVER blocked for 'too hard' or 'unproven'");
		expect(desc("update_goal")).toContain("blocked is REFUSED");
		expect(desc("check_novelty")).toContain("unverified is NEVER novel");
		expect(desc("check_novelty")).toContain("structureMatched + independentCalculation");
		expect(desc("verify_claim")).toContain("fail-closed to REFUTED");
		expect(desc("evaluate_solution")).toContain("use autoresearch_step instead");
		expect(desc("autoresearch_step")).toContain("does NOT decide keep/revert/pivot");
		expect(desc("log_progress")).toContain("does NOT count as progress");
		expect(desc("log_progress")).toContain("REQUIRES a non-empty recovery");
		expect(desc("journal_recall")).toContain("Check BEFORE re-exploring");
		expect(desc("log_research_gap")).toContain("do not log a duplicate gap");
		await rm(dir, { recursive: true, force: true });
	});
});

describe("program-awareness guard on legacy tools", () => {
	const fixtureProgram = (status: "active" | "complete") =>
		({
			objective: "guard fixture",
			criteria: [{ check: "command", description: "gate", command: "true", expect_exit: 0 }],
			nodes: [],
			journal: [],
			instruments: [],
			barriers: [],
			status,
			updatedAt: Date.now(),
		}) as never;

	test("active program: check_goal returns a scoped answer (no throw; points back to the program loop)", async () => {
		const { byName, workdir: dir } = await makeTools();
		await saveProgram(join(dir, ".kea"), fixtureProgram("active"));
		const result = (await byName("check_goal").execute("t", {})) as { content: Array<{ text: string }> };
		expect(result.content[0]?.text).toContain("program.json");
		expect(result.content[0]?.text).toContain("program loop");
	});

	test("active program: start_goal refuses dual-track creation and points to the program tools", async () => {
		const { byName, workdir: dir } = await makeTools();
		await saveProgram(join(dir, ".kea"), fixtureProgram("active"));
		await expect(byName("start_goal").execute("t", { objective: "x", criteria: [criterion] })).rejects.toThrow(
			/update_node/,
		);
	});

	test("active program: update_goal points to the program tools", async () => {
		const { byName, workdir: dir } = await makeTools();
		await saveProgram(join(dir, ".kea"), fixtureProgram("active"));
		await expect(byName("update_goal").execute("t", { status: "active" })).rejects.toThrow(/update_node/);
	});

	test("complete program: the legacy track is allowed (no mobai.json keeps the usual no active mobai)", async () => {
		const { byName, workdir: dir } = await makeTools();
		await saveProgram(join(dir, ".kea"), fixtureProgram("complete"));
		await expect(byName("check_goal").execute("t", {})).rejects.toThrow(/no active mobai/);
	});
});

describe("dual-track guard symmetry (both creation entry points start_program ↔ start_goal are closed)", () => {
	const startProgramTool = async (dir: string) => {
		const { env } = await createExecutionEnv(dir);
		const tools = createProgramTools({ cwd: dir, env });
		const tool = tools.find((t) => t.name === "start_program");
		if (!tool) throw new Error("start_program not found");
		return tool as { execute: (id: string, params: unknown) => Promise<unknown> };
	};
	const programParams = {
		objective: "new program",
		nodes: [],
		criteria: [{ check: "command", description: "d", command: "true", expect_exit: 0 }],
	};

	test("unsettled legacy mobai: start_program refuses", async () => {
		const { workdir: dir } = await makeTools();
		await saveMobaiIn(join(dir, ".kea"), {
			objective: "legacy active",
			criteria: [criterion],
			status: "active",
			progress: [],
			frontier: [],
		} as never);
		const tool = await startProgramTool(dir);
		await expect(tool.execute("t", programParams)).rejects.toThrow(/finish or clear/);
	});

	test("complete legacy mobai: start_program admitted (settled does not block)", async () => {
		const { workdir: dir } = await makeTools();
		// complete is check_goal-only via the schema guard; settled disk state is written raw
		await Bun.write(
			mobaiPathIn(join(dir, ".kea")),
			JSON.stringify({ objective: "legacy done", criteria: [], status: "complete", progress: [], frontier: [] }),
		);
		const tool = await startProgramTool(dir);
		const result = (await tool.execute("t", programParams)) as { content: Array<{ text: string }> };
		expect(result.content[0]?.text.length ?? 0).toBeGreaterThan(0);
	});

	test("active program: log_progress points to the program tools", async () => {
		const { byName, workdir: dir } = await makeTools();
		await saveProgram(join(dir, ".kea"), {
			objective: "p",
			criteria: [{ check: "command", description: "d", command: "true", expect_exit: 0 }],
			nodes: [],
			journal: [],
			instruments: [],
			barriers: [],
			status: "active",
			updatedAt: Date.now(),
		} as never);
		await expect(
			byName("log_progress").execute("t", { kind: "artifact", description: "d", evidence: "e" }),
		).rejects.toThrow(/update_node/);
	});
});

describe("corrupt program.json: the legacy guard errors instead of proceeding blindly (G6)", () => {
	test("corrupt ledger: start_goal names the file, refuses mobai.json creation (not 'no active program')", async () => {
		const { byName, workdir: dir } = await makeTools();
		await Bun.write(join(dir, ".kea", "program.json"), "{ broken ledger");
		await expect(byName("start_goal").execute("t", { objective: "x", criteria: [criterion] })).rejects.toThrow(
			/program ledger is corrupted.*program\.json/,
		);
		expect(await Bun.file(join(dir, ".kea", "mobai.json")).exists()).toBe(false); // zombie track never created
	});
});
