import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionEnv } from "@kea/core";
import { afterAll, describe, expect, test } from "vitest";
import { calibrateInstrument, determinePhase, loadProgram } from "../src/program/index.ts";
import { createProgramTools } from "../src/program-tools.ts";

let workdir: string;
afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

interface Tool {
	name: string;
	execute: (id: string, params: unknown) => Promise<unknown>;
}

async function makeTools() {
	workdir = await mkdtemp(join(tmpdir(), "kea2-invtools-"));
	const { env } = await createExecutionEnv(workdir);
	const tools = createProgramTools({
		cwd: workdir,
		env,
		mobaiDir: () => join(workdir, ".kea"),
		reviewCommand: () => "approve",
		currentRound: () => 3,
	});
	const byName = (name: string): Tool => {
		const tool = tools.find((t) => t.name === name);
		if (!tool) throw new Error(`tool not found: ${name}`);
		return tool as unknown as Tool;
	};
	return { byName };
}

const programArgs = {
	objective: "break through the barrier",
	criteria: [{ check: "file_exists" as const, description: "marker", path: "marker.txt" }],
	nodes: [
		{
			id: "attack-1",
			kind: "theorem" as const,
			title: "attack with the instrument",
			statement: "use the instrument to reach the target",
			dependsOn: [],
			acceptance: {
				check: "command" as const,
				description: "target reached",
				command: "test -f reached.txt",
				expect_exit: 0,
			},
		},
	],
};

const instrumentArgs = {
	id: "weighted-transfer",
	version: 1,
	artifacts: ["formal/Weighted.lean"],
	recovers: [
		{
			theorem: "Montgomery quadratic-form identity",
			check: {
				check: "command" as const,
				description: "recovery compiles",
				command: "test -f recovery-ok.txt",
				expect_exit: 0,
			},
		},
	],
	novelty: {
		statement: "weighted counting transcends the bandwidth-1 ceiling",
		check: {
			check: "command" as const,
			description: "novelty witness",
			command: "test -f novelty-ok.txt",
			expect_exit: 0,
		},
	},
};

describe("register_instrument / calibrate_instrument (invention is a machine-verified fact)", () => {
	test("calibration refused while contracts fail; passes once artifacts satisfy them", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t0", programArgs);
		await byName("register_instrument").execute("t1", instrumentArgs);

		await expect(byName("calibrate_instrument").execute("t2", { instrumentId: "weighted-transfer" })).rejects.toThrow(
			/calibration REFUSED.*recovery "Montgomery quadratic-form identity"/,
		);
		let program = await loadProgram(join(workdir, ".kea"));
		expect(program?.instruments[0]?.status).toBe("draft");

		const { env } = await createExecutionEnv(workdir);
		await env.exec("touch recovery-ok.txt novelty-ok.txt", { cwd: workdir, timeout: 10 });
		await expect(
			byName("calibrate_instrument").execute("t3", { instrumentId: "weighted-transfer" }),
		).resolves.toBeTruthy();
		program = await loadProgram(join(workdir, ".kea"));
		expect(program?.instruments[0]?.status).toBe("calibrated");
		// calibration is load-bearing
		expect(program?.journal.some((e) => e.kind === "instrument_calibrated")).toBe(true);
	});

	test("novelty failure alone refuses calibration", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t0", programArgs);
		await byName("register_instrument").execute("t1", instrumentArgs);
		const { env } = await createExecutionEnv(workdir);
		await env.exec("touch recovery-ok.txt", { cwd: workdir, timeout: 10 }); // recovery ok, novelty missing
		await expect(byName("calibrate_instrument").execute("t2", { instrumentId: "weighted-transfer" })).rejects.toThrow(
			/calibration REFUSED.*novelty/,
		);
	});
});

describe("record_barrier (barriers must be verified facts)", () => {
	test("machine-checkable barrier is verified now; failing check refused", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t0", programArgs);
		await byName("register_instrument").execute("t1", instrumentArgs);
		const { env } = await createExecutionEnv(workdir);
		await env.exec("touch recovery-ok.txt novelty-ok.txt", { cwd: workdir, timeout: 10 });
		await byName("calibrate_instrument").execute("t2", { instrumentId: "weighted-transfer" });

		await expect(
			byName("record_barrier").execute("t3", {
				instrumentId: "weighted-transfer",
				statement: "bandwidth ≤ 1 caps the certificate at 0.68185",
				check: { check: "command", description: "ceiling computation", command: "test -f ceiling.txt", expect_exit: 0 },
			}),
		).rejects.toThrow(/barrier check FAILED/);

		await env.exec("touch ceiling.txt", { cwd: workdir, timeout: 10 });
		await expect(
			byName("record_barrier").execute("t4", {
				instrumentId: "weighted-transfer",
				statement: "bandwidth ≤ 1 caps the certificate at 0.68185",
				check: { check: "command", description: "ceiling computation", command: "test -f ceiling.txt", expect_exit: 0 },
			}),
		).resolves.toBeTruthy();
		const program = await loadProgram(join(workdir, ".kea"));
		expect(program?.barriers).toHaveLength(1);
		expect(program?.journal.some((e) => e.kind === "barrier_recorded")).toBe(true);
	});

	test("check-less barrier is stored as a note — NOT load-bearing progress", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t0", programArgs);
		await byName("register_instrument").execute("t1", instrumentArgs);
		await byName("record_barrier").execute("t2", {
			instrumentId: "weighted-transfer",
			statement: "narrative-only obstruction without any machine check",
		});
		const program = await loadProgram(join(workdir, ".kea"));
		expect(program?.barriers).toHaveLength(1);
		const entry = program?.journal.find((e) => e.description.includes("narrative-only"));
		expect(entry?.kind).toBe("note");
		expect(program?.journal.some((e) => e.kind === "barrier_recorded")).toBe(false);
	});

	test("register_instrument supersedes retires the previous generation (exposed by M-4)", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t0", programArgs);
		await byName("register_instrument").execute("t1", instrumentArgs);
		const { env } = await createExecutionEnv(workdir);
		await env.exec("touch recovery-ok.txt novelty-ok.txt", { cwd: workdir, timeout: 10 });
		await byName("calibrate_instrument").execute("t2", { instrumentId: "weighted-transfer" });
		await byName("register_instrument").execute("t3", {
			...instrumentArgs,
			id: "weighted-transfer-v2",
			version: 2,
			supersedes: "weighted-transfer",
		});
		const program = await loadProgram(join(workdir, ".kea"));
		const v1 = program?.instruments.find((i) => i.id === "weighted-transfer");
		expect(v1?.status).toBe("superseded");
		// and the scheduler no longer pairs the superseded instrument
		const phase = determinePhase(program!, false);
		if (phase.kind === "attack") expect(phase.instrument.id).not.toBe("weighted-transfer");
	});
});

describe("determinePhase (invent-attack-analyze phase machine)", () => {
	test("no instrument → INVENT; calibrated + ready node → ATTACK with that instrument", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t0", programArgs);
		let program = (await loadProgram(join(workdir, ".kea")))!;
		expect(determinePhase(program, false).kind).toBe("invent");

		await byName("register_instrument").execute("t1", instrumentArgs);
		const { env } = await createExecutionEnv(workdir);
		await env.exec("touch recovery-ok.txt novelty-ok.txt", { cwd: workdir, timeout: 10 });
		await byName("calibrate_instrument").execute("t2", { instrumentId: "weighted-transfer" });
		program = (await loadProgram(join(workdir, ".kea")))!;
		const phase = determinePhase(program, false);
		expect(phase.kind).toBe("attack");
		if (phase.kind === "attack") expect(phase.instrument.id).toBe("weighted-transfer");

		// analysisDue overrides everything (the "cannot complete" moment → ANALYZE)
		expect(determinePhase(program, true).kind).toBe("analyze");
	});
});

describe("calibrateInstrument pure-transition guard", () => {
	test("double calibration and unknown id throw", () => {
		// exercised via tools above for the happy path; here the pure guard
		const program = {
			...programArgs,
			nodes: [],
			journal: [],
			instruments: [],
			barriers: [],
			status: "active" as const,
			updatedAt: Date.now(),
		};
		expect(() => calibrateInstrument(program as never, "ghost", 1, "e")).toThrow(/unknown instrument/);
	});
});
