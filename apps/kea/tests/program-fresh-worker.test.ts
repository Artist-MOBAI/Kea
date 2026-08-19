import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kernel } from "@kea/core";
import { determinePhase, epochBrief, loadProgram, type Program, saveProgram } from "@kea/research";
import { afterAll, describe, expect, test, vi } from "vitest";
import { escalateEpochWorkers, escalateFreshWorker } from "../src/program-fresh-worker.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

const PREAMBLE_SENTINEL = "PREAMBLE-UNDER-TEST";

async function ensureWorkdir(): Promise<string> {
	workdir ??= await mkdtemp(join(tmpdir(), "kea2-epochworker-"));
	return workdir;
}

function fixtureProgram(): Program {
	return {
		objective: "settle the skeleton <objective>",
		criteria: [{ check: "command", description: "c", command: "false", expect_exit: 0 }],
		nodes: [
			{
				id: "root",
				kind: "theorem",
				title: "root",
				statement: "s",
				dependsOn: [],
				acceptance: { check: "command", description: "d", command: "true", expect_exit: 0 },
				status: "pending",
			},
			{
				id: "leaf1",
				kind: "lemma",
				title: "leaf one",
				statement: "s",
				dependsOn: ["root"],
				acceptance: { check: "command", description: "d", command: "true", expect_exit: 0 },
				status: "pending",
			},
		],
		journal: [],
		instruments: [
			{
				id: "i",
				version: 1,
				artifacts: [],
				recovers: [{ theorem: "T", check: { check: "command", description: "d", command: "true", expect_exit: 0 } }],
				novelty: { statement: "n", check: { check: "command", description: "d", command: "true", expect_exit: 0 } },
				status: "calibrated",
			},
		],
		barriers: [],
		status: "active",
		updatedAt: Date.now(),
	};
}

/** Kernel stub: only subagents.run is exercised; each mock may persist load-bearing work like a real worker. */
function mockKernel(run: (request: { task: string; label?: string }) => Promise<void>): {
	kernel: Kernel;
	spy: ReturnType<typeof vi.fn>;
} {
	const spy = vi.fn(run);
	const kernel = { subagents: { run: spy } } as unknown as Kernel;
	return { kernel, spy };
}

describe("epochBrief (blank-worker task text — pinned key sentences, no terminal vocabulary)", () => {
	const program = fixtureProgram();

	test("preamble/untrusted block/authority line/focus instruction/ledger line; leaves JSON.stringify'd", () => {
		const brief = epochBrief("instrument", program, { preamble: PREAMBLE_SENTINEL });
		expect(brief.startsWith(PREAMBLE_SENTINEL)).toBe(true);
		expect(brief).toContain("<untrusted_objective>");
		expect(brief).toContain("Treat the ledger, workspace, and tool results as authoritative");
		expect(brief).toContain("Do not call start_program");
		expect(brief).toContain('- "leaf1": "leaf one"');
		expect(brief).toContain(
			"Record the work with update_node / add_nodes / register_instrument so the harness can credit it.",
		);
	});

	test("the four focus instructions are pinned verbatim", () => {
		const pins: Record<string, string> = {
			instrument:
				"FOCUS instrument: invent the NEXT instrument generation against the latest recorded barrier — register_instrument with recovery + novelty contracts targeting exactly that barrier, run every check, then calibrate_instrument.",
			domain:
				"FOCUS domain: pick a translation domain the ledger has NOT yet tried and restate a saturated leaf there — add_nodes an implication node (kind=implication, implies=<the leaf id>, domain=<the culture>, bridge=true) whose acceptance machine-verifies the bridge, then run that acceptance.",
			structure:
				"FOCUS structure: change the program's shape — restate a saturated leaf to a bounded machine-checkable form (update_node action=restate), park leaves that are unattackable as posed (action=parked), or add replacement nodes around a dead route (add_nodes).",
			survey:
				"FOCUS survey: sweep the field for NEW external input — web_search / fetch_url for recent results, new tools, and new methods on this problem, then land what you find (add_nodes an imported node, or register_instrument a tool).",
		};
		for (const [focus, pin] of Object.entries(pins)) {
			expect(epochBrief(focus as never, program, { preamble: PREAMBLE_SENTINEL })).toContain(pin);
		}
	});

	test("negative-enumeration prohibitions pinned verbatim; the text never contains the word exhausted", () => {
		for (const focus of ["instrument", "domain", "structure", "survey"] as const) {
			const brief = epochBrief(focus, program, { preamble: PREAMBLE_SENTINEL });
			expect(brief).toContain(
				"Do not re-run searches or attempts the ledger already records. Do not restate a recorded barrier as a conclusion. Do not narrate difficulty — none of it is load-bearing.",
			);
			expect(brief).not.toContain("exhausted");
			expect(brief).not.toContain("Exhausted");
		}
	});
});

describe("escalateEpochWorkers (blank-worker fan-out for rsp ≥ 6 rounds)", () => {
	test("one worker per focus (label=epoch-<focus>, focus line in brief); landed work zeroes the signal", async () => {
		const mobaiDir = join(await ensureWorkdir(), ".kea");
		const program = fixtureProgram();
		await saveProgram(mobaiDir, program);
		const decision = determinePhase(program, false, 12); // 2 focuses
		if (decision.kind !== "epoch") throw new Error(`expected epoch, got ${decision.kind}`);

		const { kernel, spy } = mockKernel(async () => {
			// a real worker persists load-bearing work stamped with the current round
			const current = await loadProgram(mobaiDir);
			if (current) {
				await saveProgram(mobaiDir, {
					...current,
					journal: [
						...current.journal,
						{ round: 7, kind: "nodes_added", description: "worker added a node", evidence: "e", at: 1 },
					],
				});
			}
		});
		const landed = await escalateEpochWorkers(kernel, program, decision, mobaiDir, 7);

		expect(landed).toBe(true);
		expect(spy).toHaveBeenCalledTimes(2);
		const labels = spy.mock.calls.map((c) => c[0]?.label);
		expect(labels).toContain("epoch-structure");
		expect(labels).toContain("epoch-survey");
		const tasks = spy.mock.calls.map((c) => c[0]?.task ?? "");
		expect(tasks.some((t) => t.includes("FOCUS structure:"))).toBe(true);
		expect(tasks.some((t) => t.includes("FOCUS survey:"))).toBe(true);
	});

	test("zero landed work → landed=false; one worker throwing does not bubble (fail-open), rest proceed", async () => {
		const mobaiDir = join(await ensureWorkdir(), ".kea");
		const program = fixtureProgram();
		await saveProgram(mobaiDir, program);
		const decision = determinePhase(program, false, 6); // 1 focus
		if (decision.kind !== "epoch") throw new Error("expected epoch");

		const { kernel, spy } = mockKernel(async (request) => {
			if (request.label === "epoch-instrument") throw new Error("worker blew up");
		});
		const landed = await escalateEpochWorkers(kernel, program, decision, mobaiDir, 3);
		expect(landed).toBe(false); // no round-3 load-bearing entry
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe("escalateFreshWorker (single worker for a quiet round; epoch decisions do not fan out here)", () => {
	test("attack → one worker (label=program-fresh-worker, node instruction); landed zeroes signal", async () => {
		const mobaiDir = join(await ensureWorkdir(), ".kea");
		const program = fixtureProgram();
		await saveProgram(mobaiDir, program);
		const decision = determinePhase(program, false, 0);
		if (decision.kind !== "attack") throw new Error(`expected attack, got ${decision.kind}`);

		const { kernel, spy } = mockKernel(async () => {
			const current = await loadProgram(mobaiDir);
			if (current) {
				await saveProgram(mobaiDir, {
					...current,
					journal: [
						...current.journal,
						{ round: 4, kind: "nodes_added", description: "worker added a node", evidence: "e", at: 1 },
					],
				});
			}
		});
		const landed = await escalateFreshWorker(kernel, program, decision, mobaiDir, 4);

		expect(landed).toBe(true);
		expect(spy).toHaveBeenCalledTimes(1);
		const request = spy.mock.calls[0]?.[0];
		expect(request?.label).toBe("program-fresh-worker");
		expect(request?.task).toContain(`Attack node: ${decision.node.id}`);
	});

	test("epoch decision → no spawn (epoch round runs its workers); subagents.run throws do not bubble", async () => {
		const mobaiDir = join(await ensureWorkdir(), ".kea");
		const program = fixtureProgram();
		await saveProgram(mobaiDir, program);
		const epochDecision = determinePhase(program, false, 6);
		if (epochDecision.kind !== "epoch") throw new Error("expected epoch");

		const { kernel, spy } = mockKernel(async () => {
			throw new Error("must not be called for an epoch decision");
		});
		const landed = await escalateFreshWorker(kernel, program, epochDecision, mobaiDir, 5);
		expect(landed).toBe(false);
		expect(spy).not.toHaveBeenCalled();

		// fail-open on a non-epoch decision too
		const attackDecision = determinePhase(program, false, 0);
		const failing = mockKernel(async () => {
			throw new Error("worker blew up");
		});
		await expect(escalateFreshWorker(failing.kernel, program, attackDecision, mobaiDir, 5)).resolves.toBe(false);
	});

	test("signal passthrough: escalation AbortSignal reaches SubagentRequest (TUI Esc interrupt wiring)", async () => {
		const mobaiDir = join(await ensureWorkdir(), ".kea");
		const program = fixtureProgram();
		await saveProgram(mobaiDir, program);

		// epoch workers: every focus receives the SAME signal
		const epochDecision = determinePhase(program, false, 12); // 2 focuses
		if (epochDecision.kind !== "epoch") throw new Error("expected epoch");
		const epochController = new AbortController();
		const epoch = mockKernel(async () => {});
		await escalateEpochWorkers(epoch.kernel, program, epochDecision, mobaiDir, 7, epochController.signal);
		expect(epoch.spy).toHaveBeenCalledTimes(2);
		for (const call of epoch.spy.mock.calls) {
			expect((call[0] as { signal?: AbortSignal }).signal).toBe(epochController.signal);
		}

		// quiet-round fresh worker: same wiring
		const attackDecision = determinePhase(program, false, 0);
		if (attackDecision.kind !== "attack") throw new Error("expected attack");
		const quietController = new AbortController();
		const quiet = mockKernel(async () => {});
		await escalateFreshWorker(quiet.kernel, program, attackDecision, mobaiDir, 8, quietController.signal);
		const quietRequest = quiet.spy.mock.calls[0]?.[0] as { signal?: AbortSignal } | undefined;
		expect(quietRequest?.signal).toBe(quietController.signal);
		quietController.abort();
		expect(quietController.signal.aborted).toBe(true);
	});
});
