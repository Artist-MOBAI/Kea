import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createExecutionEnv, createKernel, type Kernel } from "@kea/core";
import { createProgramTools, type Program, saveProgram } from "@kea/research";
import { afterAll, describe, expect, test, vi } from "vitest";
import { runProgramLoop } from "../src/headless/program.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

async function makeKernel(
	responses: ReturnType<typeof fauxAssistantMessage>[],
	roundRef?: { current: number },
): Promise<Kernel> {
	workdir = await mkdtemp(join(tmpdir(), "kea2-progloop-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const m = faux.getModel();
	faux.setResponses(responses);
	const { env } = await createExecutionEnv(workdir);
	return createKernel({
		cwd: workdir,
		models,
		model: `${m.provider}/${m.id}`,
		permissionMode: "auto",
		headless: true,
		extraTools: createProgramTools({
			cwd: workdir,
			env,
			mobaiDir: () => join(workdir, ".kea"),
			reviewCommand: () => "approve",
			// wired to the loop's setProgramRound so tool journal stamps follow the loop's absolute rounds
			currentRound: () => roundRef?.current ?? 1,
		}),
	});
}

async function seedProgram(dir: string, headRound = 0, instruments: Program["instruments"] = []) {
	await saveProgram(join(dir, ".kea"), {
		objective: "produce both markers through the DAG",
		criteria: [{ check: "command", description: "second marker exists", command: "test -f done2.txt", expect_exit: 0 }],
		nodes: [
			{
				id: "n1",
				kind: "lemma",
				title: "first marker",
				statement: "the file done1.txt exists",
				dependsOn: [],
				acceptance: { check: "command", description: "marker1 exists", command: "test -f done1.txt", expect_exit: 0 },
				status: headRound > 0 ? "proved" : "pending",
			},
			{
				id: "n2",
				kind: "theorem",
				title: "second marker",
				statement: "the file done2.txt exists (requires n1)",
				dependsOn: ["n1"],
				acceptance: { check: "command", description: "marker2 exists", command: "test -f done2.txt", expect_exit: 0 },
				status: "pending",
			},
		],
		journal:
			headRound > 0
				? [
						{
							round: headRound,
							kind: "node_proved",
							nodeId: "n1",
							description: "proved by a previous process",
							evidence: "prior run",
							at: 1,
						},
					]
				: [],
		instruments,
		barriers: [],
		status: "active",
		updatedAt: Date.now(),
	});
}

describe("runProgramLoop (node-driven research program)", () => {
	test("DAG rounds: node prompts drive work, machine acceptance gates prove, criteria complete", async () => {
		// each round: create the artifact, then claim proved — the tool re-verifies via acceptance
		const kernel = await makeKernel([
			fauxAssistantMessage([
				fauxToolCall("bash", { command: "touch done1.txt" }),
				fauxToolCall("update_node", { action: "proved", nodeId: "n1", evidence: "created done1.txt" }),
			]),
			fauxAssistantMessage("n1 settled"),
			fauxAssistantMessage([
				fauxToolCall("bash", { command: "touch done2.txt" }),
				fauxToolCall("update_node", { action: "proved", nodeId: "n2", evidence: "created done2.txt" }),
			]),
			fauxAssistantMessage("n2 settled"),
		]);
		await seedProgram(workdir);

		const report = await runProgramLoop(kernel, { cwd: workdir, maxRounds: 5, wallClockMs: 120_000 });

		expect(report.outcome).toBe("complete");
		expect(report.rounds).toBe(2); // settled at the start of round 3's criteria check
		const { loadProgram } = await import("@kea/research");
		const program = await loadProgram(join(workdir, ".kea"));
		expect(program?.nodes.map((n) => n.status)).toEqual(["proved", "proved"]);
		expect(program?.journal.filter((e) => e.kind === "node_proved")).toHaveLength(2);
		await kernel.close();
	}, 60_000);

	test("prove without the artifact is refused by the machine acceptance gate (node stays pending)", async () => {
		const kernel = await makeKernel(Array.from({ length: 10 }, () => fauxAssistantMessage("claimed without evidence")));
		await seedProgram(workdir);

		const report = await runProgramLoop(kernel, { cwd: workdir, maxRounds: 2, wallClockMs: 120_000 });
		// The essential invariant: no fake complete, and the node never becomes proved without its artifact.
		expect(report.outcome).not.toBe("complete");
		const { loadProgram } = await import("@kea/research");
		const program = await loadProgram(join(workdir, ".kea"));
		expect(program?.nodes[0]?.status).toBe("pending");
		expect(program?.journal.some((e) => e.kind === "node_proved")).toBe(false);
		await kernel.close();
	}, 60_000);

	test("no program formalized → blocked (exit-code semantics 3)", async () => {
		const kernel = await makeKernel([fauxAssistantMessage("nothing")]);
		const report = await runProgramLoop(kernel, { cwd: workdir, maxRounds: 2, wallClockMs: 60_000 });
		expect(report.outcome).toBe("blocked");
		expect(report.detail).toContain("no program");
		await kernel.close();
	}, 60_000);

	test("deep stagnation (rsp ≥ 6) → epoch blank-worker round, no exhausted exit (never self-stops)", async () => {
		const kernel = await makeKernel(
			// rounds 1–6: narration only — no journal work, the stagnation counter climbs the ladder
			Array.from({ length: 6 }, (_, i) => fauxAssistantMessage(`round ${i + 1}: nothing load-bearing`)),
		);
		await seedProgram(workdir);
		const spy = vi.spyOn(kernel.subagents, "run").mockResolvedValue({
			id: "stub",
			profile: "default",
			summary: "",
			turns: 0,
			budgetExhausted: false,
			failed: false,
		});

		const report = await runProgramLoop(kernel, { cwd: workdir, maxRounds: 7, wallClockMs: 600_000 });

		// round 7: the scheduler hands the round to a blank epoch worker (rsp=6 → focus instrument)
		const labels = spy.mock.calls.map((c) => c[0]?.label);
		expect(labels).toContain("epoch-instrument");
		const epochTask = spy.mock.calls.find((c) => c[0]?.label === "epoch-instrument")?.[0]?.task ?? "";
		expect(epochTask).toContain("FOCUS instrument:");
		expect(report.outcome).toBe("budget_exhausted");
		const { loadProgram } = await import("@kea/research");
		const program = await loadProgram(join(workdir, ".kea"));
		expect(program?.status).toBe("active");
		spy.mockRestore();
		await kernel.close();
	}, 60_000);

	test("epoch round budget gate: remaining budget < 2min skips workers, settles budget_exhausted directly", async () => {
		const kernel = await makeKernel(
			// six narration rounds climb rsp to 6; the whole run finishes well inside the 30s budget,
			// so the epoch round at 7 sees remaining < FRESH_WORKER_MIN_MS (120s)
			Array.from({ length: 6 }, (_, i) => fauxAssistantMessage(`round ${i + 1}: nothing load-bearing`)),
		);
		await seedProgram(workdir);
		const spy = vi.spyOn(kernel.subagents, "run").mockResolvedValue({
			id: "stub",
			profile: "default",
			summary: "",
			turns: 0,
			budgetExhausted: false,
			failed: false,
		});
		const logs: string[] = [];

		const report = await runProgramLoop(kernel, {
			cwd: workdir,
			maxRounds: 7,
			wallClockMs: 30_000,
			log: (line) => logs.push(line),
		});

		expect(report.outcome).toBe("budget_exhausted");
		expect(report.rounds).toBe(6); // the epoch round never ran
		expect(report.detail).toContain("epoch workers");
		expect(spy).not.toHaveBeenCalled(); // workers never launched with a budget they cannot fit
		expect(logs.some((l) => l.includes("settling budget_exhausted without workers"))).toBe(true);
		spy.mockRestore();
		await kernel.close();
	}, 60_000);

	test("relative round cap: journal at round 25, cap 2 adds exactly 2 rounds, stamped absolute 26/27", async () => {
		const roundRef = { current: 1 };
		const kernel = await makeKernel(
			[
				fauxAssistantMessage([fauxToolCall("update_node", { action: "started", nodeId: "n2" })]),
				fauxAssistantMessage("round 26 done"),
				fauxAssistantMessage([
					fauxToolCall("update_node", { action: "parked", nodeId: "n2", reason: "shelved for a future generation" }),
				]),
				fauxAssistantMessage("round 27 done"),
			],
			roundRef,
		);
		await seedProgram(workdir, 25); // journal head at round 25 (n1 proved by a previous process)

		const rounds: number[] = [];
		const report = await runProgramLoop(kernel, {
			cwd: workdir,
			maxRounds: 2,
			// < FRESH_WORKER_MIN_MS total ⇒ quiet rounds deterministically skip fresh-worker escalation
			wallClockMs: 60_000,
			setProgramRound: (r) => {
				roundRef.current = r;
			},
			onRound: (r) => rounds.push(r),
		});

		expect(report.outcome).toBe("budget_exhausted");
		expect(report.rounds).toBe(2); // rounds ADDED by this process, not the absolute round number
		expect(rounds).toEqual([26, 27]);
		const { loadProgram } = await import("@kea/research");
		const program = await loadProgram(join(workdir, ".kea"));
		const stamps = program?.journal.filter((e) => e.round > 25).map((e) => e.round) ?? [];
		expect(stamps).toEqual([26, 27]); // journal stamps stay absolute and unique
		expect(program?.journal.at(-1)).toMatchObject({ kind: "node_parked", nodeId: "n2", round: 27 });
		await kernel.close();
	}, 60_000);

	test("tail settleComplete uses the last executed round: head 25 + cap 2 → program_completed round 27", async () => {
		const roundRef = { current: 1 };
		const kernel = await makeKernel(
			[
				fauxAssistantMessage([
					fauxToolCall("update_node", { action: "parked", nodeId: "n2", reason: "not attackable as posed" }),
				]),
				fauxAssistantMessage("round 26 done"),
				fauxAssistantMessage("round 27: narration only"),
				fauxAssistantMessage("unused"),
			],
			roundRef,
		);
		await seedProgram(workdir, 25, [
			{
				id: "tool",
				version: 1,
				artifacts: [],
				recovers: [{ theorem: "T", check: { check: "command", description: "d", command: "true", expect_exit: 0 } }],
				novelty: { statement: "n", check: { check: "command", description: "d", command: "true", expect_exit: 0 } },
				status: "calibrated",
			},
		]);

		// round 26 ATTACKs n2 and parks it (load-bearing ⇒ no fresh worker); round 27 is then
		// reform:weaken (a DIFFERENT phase key, so the phase-stuck breaker stays quiet) and narrates
		// only ⇒ quiet round ⇒ the fresh worker (mocked) lands the criteria artifact AFTER the
		// post-round recheck, so only the tail recheck sees completion — pinning the tail's stamp to
		// the actual last executed round
		const spy = vi.spyOn(kernel.subagents, "run").mockImplementation(async () => {
			await Bun.write(join(workdir, "done2.txt"), "");
			return { id: "stub", profile: "default", summary: "", turns: 0, budgetExhausted: false, failed: false };
		});

		const report = await runProgramLoop(kernel, {
			cwd: workdir,
			maxRounds: 2,
			wallClockMs: 600_000, // ≥ FRESH_WORKER_MIN_MS remaining ⇒ the quiet round really escalates
			setProgramRound: (r) => {
				roundRef.current = r;
			},
		});

		expect(report.outcome).toBe("complete");
		expect(report.rounds).toBe(2);
		const { loadProgram } = await import("@kea/research");
		const program = await loadProgram(join(workdir, ".kea"));
		expect(program?.status).toBe("complete");
		expect(program?.journal.at(-1)).toMatchObject({ kind: "program_completed", round: 27 }); // not the cap value 2
		// round judge first (semantic verdict on the quiet round), then the fresh worker
		expect(spy).toHaveBeenCalledTimes(2);
		expect(spy.mock.calls[0]?.[0]?.label).toBe("round-judge");
		expect(spy.mock.calls[1]?.[0]?.label).toBe("program-fresh-worker");
		spy.mockRestore();
		await kernel.close();
	}, 60_000);
});
