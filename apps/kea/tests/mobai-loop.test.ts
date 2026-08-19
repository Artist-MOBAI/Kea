import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createKernel, type Kernel } from "@kea/core";
import { loadMobai, saveMobai } from "@kea/research";
import { afterAll, describe, expect, test, vi } from "vitest";
import { nextBlockedStreak, runMobaiLoop } from "../src/headless/mobai.ts";
import { makeTempDir, removeTempDir } from "./helpers/temp-dir.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await removeTempDir(workdir);
});

async function makeKernel(): Promise<Kernel> {
	workdir = await makeTempDir("kea2-mobailoop-");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const m = faux.getModel();

	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("working on it")));
	return createKernel({ cwd: workdir, models, model: `${m.provider}/${m.id}`, permissionMode: "auto", headless: true });
}

describe("runMobaiLoop (M6 final supplementary tests)", () => {
	test("criteria all pass → complete (machine-set, exit-code semantics 0)", async () => {
		const kernel = await makeKernel();
		await saveMobai(workdir, {
			objective: "produce the marker file",
			criteria: [{ check: "command", description: "echo passes", command: "echo done", expect_exit: 0 }],
			status: "active",
			updatedAt: Date.now(),
			frontier: [],
			progress: [],
		});
		const report = await runMobaiLoop(kernel, { cwd: workdir, maxRounds: 3, wallClockMs: 120_000 });
		expect(report.outcome).toBe("complete");
		expect(report.rounds).toBe(1);
		await kernel.close();
	}, 60_000);

	test("criteria fail + rounds exhausted → budget_exhausted (exit-code semantics 2)", async () => {
		const kernel = await makeKernel();
		await saveMobai(workdir, {
			objective: "impossible",
			criteria: [{ check: "command", description: "always fails", command: "exit 1", expect_exit: 0 }],
			status: "active",
			updatedAt: Date.now(),
			frontier: [],
			progress: [],
		});
		const report = await runMobaiLoop(kernel, { cwd: workdir, maxRounds: 1, wallClockMs: 120_000 });
		expect(report.outcome).toBe("budget_exhausted");
		expect(report.rounds).toBe(1);
		await kernel.close();
	}, 60_000);

	test("no goal and no objective given → blocked (exit-code semantics 3)", async () => {
		const kernel = await makeKernel();
		const report = await runMobaiLoop(kernel, { cwd: workdir, maxRounds: 3, wallClockMs: 120_000 });
		expect(report.outcome).toBe("blocked");
		await kernel.close();
	}, 60_000);

	test("wall-clock exhausted → budget_exhausted", async () => {
		const kernel = await makeKernel();
		await saveMobai(workdir, {
			objective: "slow",
			criteria: [{ check: "command", description: "fails", command: "exit 1", expect_exit: 0 }],
			status: "active",
			updatedAt: Date.now(),
			frontier: [],
			progress: [],
		});
		const report = await runMobaiLoop(kernel, { cwd: workdir, maxRounds: 10, wallClockMs: 1 });
		expect(report.outcome).toBe("budget_exhausted");
		expect(report.detail).toContain("wall-clock");
		await kernel.close();
	}, 60_000);

	test("slow criterion command capped by the wall-clock budget, never its own full duration (regression)", async () => {
		const kernel = await makeKernel();
		await saveMobai(workdir, {
			objective: "slow criterion",
			criteria: [{ check: "command", description: "sleeps past the budget", command: "sleep 10", expect_exit: 0 }],
			status: "active",
			updatedAt: Date.now(),
			frontier: [],
			progress: [],
		});
		const startedAt = Date.now();
		const report = await runMobaiLoop(kernel, { cwd: workdir, maxRounds: 3, wallClockMs: 2_000 });
		const elapsedMs = Date.now() - startedAt;
		expect(report.outcome).toBe("budget_exhausted");
		// criterion commands must be capped by the wall-clock budget, not run their own full duration
		expect(elapsedMs).toBeLessThan(8_000);
		await kernel.close();
	}, 60_000);

	test("criteria met in the final round → post-loop recheck settles complete (not budget_exhausted)", async () => {
		const kernel = await makeKernel();
		const marker = join(workdir, "mobai-final-marker");
		// First check: marker missing → create and fail; second check (post-loop re-check): present → pass
		await saveMobai(workdir, {
			objective: "passes on the second check",
			criteria: [
				{
					check: "command",
					description: "passes on second invocation",
					command: `test -f '${marker}' || { touch '${marker}'; exit 1; }`,
					expect_exit: 0,
				},
			],
			status: "active",
			updatedAt: Date.now(),
			frontier: [],
			progress: [],
		});
		const report = await runMobaiLoop(kernel, { cwd: workdir, maxRounds: 1, wallClockMs: 120_000 });
		expect(report.outcome).toBe("complete");
		expect(report.rounds).toBe(1);
		await kernel.close();
	}, 60_000);

	test("no maxRounds/wallClockMs → unlimited rounds until criteria pass (past the old 12-round cap)", async () => {
		const kernel = await makeKernel();
		const spy = vi.spyOn(kernel.subagents, "run").mockResolvedValue({
			id: "stub",
			profile: "default",
			summary: "",
			turns: 0,
			budgetExhausted: false,
			failed: false,
		});
		// criterion passes on the 14th invocation — beyond the old default cap of 12
		await saveMobai(workdir, {
			objective: "passes late",
			criteria: [
				{
					check: "command",
					description: "passes on 14th invocation",
					command: `sh -c 'n=$(cat cnt 2>/dev/null || echo 0); n=$((n+1)); echo $n > cnt; [ "$n" -ge 14 ]'`,
					expect_exit: 0,
				},
			],
			status: "active",
			updatedAt: Date.now(),
			frontier: [
				{ id: "a1", kind: "attack", description: "direct", falsification_criterion: "counterexample", status: "open" },
			],
			progress: [],
		});
		const report = await runMobaiLoop(kernel, { cwd: workdir });
		expect(report.outcome).toBe("complete");
		expect(report.rounds).toBe(14);
		spy.mockRestore();
		await kernel.close();
	}, 120_000);

	test("escalation window wall-clock capped: hung fresh worker skips its BudgetGuard → budget_exhausted", async () => {
		const kernel = await makeKernel();
		await saveMobai(workdir, {
			objective: "impossible",
			criteria: [{ check: "command", description: "always fails", command: "exit 1", expect_exit: 0 }],
			status: "active",
			updatedAt: Date.now(),
			frontier: [
				{ id: "a1", kind: "attack", description: "direct", falsification_criterion: "counterexample", status: "open" },
			],
			progress: [],
		});
		const spy = vi.spyOn(kernel.subagents, "run").mockImplementation(() => new Promise<never>(() => {}));
		const report = await runMobaiLoop(kernel, { cwd: workdir, maxRounds: 5, wallClockMs: 3_000 });
		expect(report.outcome).toBe("budget_exhausted");
		expect(report.detail).toContain("during escalation");
		expect(report.rounds).toBe(1);
		spy.mockRestore();
		await kernel.close();
	}, 60_000);
});

describe("runMobaiLoop (honest-abandonment orchestration)", () => {
	test("fake-progress regression: fresh-worker summaries are no longer recorded as artifact progress", async () => {
		const kernel = await makeKernel();
		await saveMobai(workdir, {
			objective: "impossible",
			criteria: [{ check: "command", description: "always fails", command: "exit 1", expect_exit: 0 }],
			status: "active",
			updatedAt: Date.now(),
			frontier: [
				{ id: "a1", kind: "attack", description: "direct", falsification_criterion: "counterexample", status: "open" },
			],
			progress: [],
		});
		const report = await runMobaiLoop(kernel, { cwd: workdir, maxRounds: 2, wallClockMs: 120_000 });
		expect(report.outcome).toBe("budget_exhausted");
		const mobai = await loadMobai(workdir);
		expect(mobai?.progress).toEqual([]);
		expect(mobai?.status).not.toBe("blocked");
		await kernel.close();
	}, 120_000);

	test("honest refusal → judge classifies abandonment → empty-context sea (mobai-sea), not a stop", async () => {
		workdir = await makeTempDir("kea2-mobaisea-");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const m = faux.getModel();
		faux.setResponses([
			// cjk-fixture: honest CJK refusal prose fed to the (faked) semantic abandonment judge
			fauxAssistantMessage("我不声称、也不会声称我能在本会话证明它，这是诚实边界"),
			// the round judge (fresh-context reader subagent) classifies the refusal prose semantically
			fauxAssistantMessage('{"classification": "abandonment", "missing_capability": "a new spectral tool"}'),
			...Array.from({ length: 18 }, () => fauxAssistantMessage("working on it")),
		]);
		const kernel = await createKernel({
			cwd: workdir,
			models,
			model: `${m.provider}/${m.id}`,
			permissionMode: "auto",
			headless: true,
		});
		await saveMobai(workdir, {
			objective: "prove the theorem",
			criteria: [{ check: "command", description: "always fails", command: "exit 1", expect_exit: 0 }],
			status: "active",
			updatedAt: Date.now(),
			frontier: [
				{ id: "a1", kind: "attack", description: "direct", falsification_criterion: "counterexample", status: "open" },
			],
			progress: [],
		});
		const report = await runMobaiLoop(kernel, { cwd: workdir, maxRounds: 1, wallClockMs: 120_000 });
		expect(report.outcome).toBe("budget_exhausted"); // refusal is a phase change, never a terminal stop
		const seaDir = join(workdir, ".kea", "subagents");
		const records = readdirSync(seaDir).filter((f) => f.endsWith(".json"));
		const seaRecords = await Promise.all(
			records.map(async (f) => JSON.parse(await Bun.file(join(seaDir, f)).text()) as { request?: { label?: string } }),
		);
		expect(seaRecords.some((r) => r.request?.label === "mobai-sea")).toBe(true);
		await kernel.close();
	}, 120_000);

	test("transient mid-stream socket close → retries the round instead of killing the run (regression)", async () => {
		workdir = await makeTempDir("kea2-mobaitransient-");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const m = faux.getModel();
		// round 1: mid-stream socket drop (content already produced → the stream layer does NOT retry)
		faux.setResponses([
			fauxAssistantMessage("partial work before disconnect", {
				stopReason: "error",
				errorMessage:
					"The socket connection was closed unexpectedly. for more information, pass `verbose: true` in the second argument to fetch()",
			}),
			...Array.from({ length: 20 }, () => fauxAssistantMessage("working on it")),
		]);
		const kernel = await createKernel({
			cwd: workdir,
			models,
			model: `${m.provider}/${m.id}`,
			permissionMode: "auto",
			headless: true,
		});
		await saveMobai(workdir, {
			objective: "prove the theorem",
			criteria: [{ check: "command", description: "always fails", command: "exit 1", expect_exit: 0 }],
			status: "active",
			updatedAt: Date.now(),
			frontier: [],
			progress: [],
		});
		const report = await runMobaiLoop(kernel, {
			cwd: workdir,
			maxRounds: 1,
			wallClockMs: 120_000,
			transientBackoffMs: 5,
		});
		expect(report.outcome).toBe("budget_exhausted");
		expect(report.detail ?? "").not.toContain("socket");
		await kernel.close();
	}, 120_000);

	test("transient errors terminal only after the cap; non-retryable (auth) → immediate error", async () => {
		workdir = await makeTempDir("kea2-mobaitransientcap-");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const m = faux.getModel();
		faux.setResponses(
			Array.from({ length: 10 }, () =>
				fauxAssistantMessage("x", {
					stopReason: "error",
					errorMessage: "The socket connection was closed unexpectedly",
				}),
			),
		);
		const kernel = await createKernel({
			cwd: workdir,
			models,
			model: `${m.provider}/${m.id}`,
			permissionMode: "auto",
			headless: true,
		});
		await saveMobai(workdir, {
			objective: "prove the theorem",
			criteria: [{ check: "command", description: "always fails", command: "exit 1", expect_exit: 0 }],
			status: "active",
			updatedAt: Date.now(),
			frontier: [],
			progress: [],
		});
		const report = await runMobaiLoop(kernel, {
			cwd: workdir,
			maxRounds: 20,
			wallClockMs: 120_000,
			transientBackoffMs: 1,
		});
		expect(report.outcome).toBe("error");
		expect(report.detail).toContain("socket");
		await kernel.close();

		workdir = await makeTempDir("kea2-mobaiautherr-");
		const faux2 = fauxProvider();
		const models2 = createModels();
		models2.setProvider(faux2.provider);
		const m2 = faux2.getModel();
		faux2.setResponses([fauxAssistantMessage("x", { stopReason: "error", errorMessage: "invalid api key (401)" })]);
		const kernel2 = await createKernel({
			cwd: workdir,
			models: models2,
			model: `${m2.provider}/${m2.id}`,
			permissionMode: "auto",
			headless: true,
		});
		await saveMobai(workdir, {
			objective: "prove the theorem",
			criteria: [{ check: "command", description: "always fails", command: "exit 1", expect_exit: 0 }],
			status: "active",
			updatedAt: Date.now(),
			frontier: [],
			progress: [],
		});
		const report2 = await runMobaiLoop(kernel2, {
			cwd: workdir,
			maxRounds: 20,
			wallClockMs: 120_000,
			transientBackoffMs: 1,
		});
		expect(report2.outcome).toBe("error");
		expect(report2.detail).toContain("invalid api key");
		await kernel2.close();
	}, 120_000);

	test("mid-round check_goal settle → complete at once, no sea for a finished objective (regression)", async () => {
		workdir = await makeTempDir("kea2-mobaimidcomplete-");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const m = faux.getModel();
		faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("working on it")));
		const kernel = await createKernel({
			cwd: workdir,
			models,
			model: `${m.provider}/${m.id}`,
			permissionMode: "auto",
			headless: true,
		});
		// criterion command simulates the worker settling mid-round: first run marks the mobai complete
		// on disk and fails, mirroring a mid-round check_goal passing artifacts produced in the same round
		const settleScript = join(workdir, "settle.sh");
		await Bun.write(
			settleScript,
			[
				"#!/bin/sh",
				"if [ ! -f marker ]; then",
				"  touch marker",
				'  bun -e \'const f=".kea/mobai.json";const g=JSON.parse(await Bun.file(f).text());g.status="complete";await Bun.write(f,JSON.stringify(g,null,2));\'',
				"  exit 1",
				"fi",
				"exit 0",
			].join("\n"),
		);
		await saveMobai(workdir, {
			objective: "settles mid-round",
			// empty frontier → attacksClosed is true, which would otherwise fire sea against the completed mobai
			criteria: [
				{
					check: "command",
					description: "settles on second invocation",
					command: `sh ${settleScript}`,
					expect_exit: 0,
				},
			],
			status: "active",
			updatedAt: Date.now(),
			frontier: [],
			progress: [],
		});
		const report = await runMobaiLoop(kernel, { cwd: workdir, maxRounds: 5, wallClockMs: 120_000 });
		expect(report.outcome).toBe("complete");
		expect(report.rounds).toBe(1);
		const seaDir = join(workdir, ".kea", "subagents");
		let records: string[] = [];
		try {
			records = readdirSync(seaDir).filter((f) => f.endsWith(".json"));
		} catch {
			// directory never created → no subagents ran
		}
		expect(records).toEqual([]);
		await kernel.close();
	}, 120_000);

	test("nextBlockedStreak: terminal only on 3 same-cause blocked rounds; single/changed/active continue", () => {
		const blocked = {
			status: "blocked" as const,
			blockedReason: { kind: "missing_credential" as const, detail: "no key" },
		};
		let state = nextBlockedStreak({ fingerprint: "", count: 0 }, blocked);
		expect(state.terminal).toBe(false);
		expect(state.streak.count).toBe(1);
		state = nextBlockedStreak(state.streak, blocked);
		expect(state.terminal).toBe(false);
		expect(state.streak.count).toBe(2);
		state = nextBlockedStreak(state.streak, blocked);
		expect(state.terminal).toBe(true);
		const changed = nextBlockedStreak(
			{ fingerprint: "missing_credential: no key", count: 2 },
			{ status: "blocked", blockedReason: { kind: "hardware" as const, detail: "no GPU" } },
		);
		expect(changed.terminal).toBe(false);
		expect(changed.streak.count).toBe(1);
		const reset = nextBlockedStreak({ fingerprint: "x", count: 2 }, { status: "active" as const });
		expect(reset.streak.count).toBe(0);
		expect(reset.terminal).toBe(false);
	});
});
