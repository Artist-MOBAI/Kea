import { describe, expect, test } from "vitest";
import {
	determinePhase,
	INSTRUMENT_MISMATCH_MARKER,
	type PairingState,
	type Program,
	type SettleState,
	settleRound,
} from "../src/program/index.ts";
import { roundMadeProgress } from "../src/program/ledger.ts";

const programWith = (over: Partial<Program>): Program =>
	({
		objective: "o",
		criteria: [{ check: "command", description: "c", command: "false", expect_exit: 0 }],
		nodes: [],
		journal: [],
		instruments: [],
		barriers: [],
		status: "active",
		updatedAt: 0,
		...over,
	}) as Program;

const attackPhase = (nodeId: string, instrumentId: string) =>
	({
		kind: "attack",
		node: { id: nodeId, instrumentId },
		instrument: { id: instrumentId },
	}) as never;

describe("settleRound (shared round settlement — single source for headless and TUI)", () => {
	test("refusal prose never changes settlement (prose has no channel); node_started/note stay non-load-bearing", () => {
		const program = programWith({
			journal: [{ round: 1, kind: "node_started", nodeId: "n", description: "d", evidence: "e", at: 1 }],
		});
		const refusalProse = settleRound({
			program,
			prev: { pairing: undefined, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 0 },
			phase: attackPhase("n", "i"),
			// cjk-fixture: CJK+English refusal prose proving settleRound never scans prose in any language
			lastAssistantText: "这是 Clay 千禧问题，单轮无法完成，我不会假装能；I honestly cannot complete this",
			round: 1,
		});
		// the engine never scans prose: an inability declaration is not a settle input — only the
		// loop-level semantic judge (outside settleRound) may classify it for a phase rotation
		expect("refusalDetected" in refusalProse).toBe(false);
		expect(refusalProse.madeProgress).toBe(false); // starting/narrating is not finishing
		expect(refusalProse.next.analysisDue).toBe(false);
		expect(refusalProse.next.roundsSinceProgress).toBe(1);
		const plainProse = settleRound({
			program,
			prev: { pairing: undefined, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 0 },
			phase: attackPhase("n", "i"),
			lastAssistantText: "ran the sieve, deviation 0.009",
			round: 1,
		});
		expect(plainProse.next).toEqual(refusalProse.next); // identical settlement regardless of prose
	});

	test("INSTRUMENT_MISMATCH must be the last line (restating the protocol mid-text does not trigger)", () => {
		const base = {
			program: programWith({}),
			prev: { pairing: undefined, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 0 } as SettleState,
			phase: attackPhase("n", "i"),
			round: 1,
		};
		const declared = settleRound({ ...base, lastAssistantText: `analysis…\nplan\n${INSTRUMENT_MISMATCH_MARKER}` });
		expect(declared.mismatchDeclared).toBe(true);
		expect(declared.next.analysisDue).toBe(true);
		const restated = settleRound({
			...base,
			lastAssistantText: `The protocol says end with ${INSTRUMENT_MISMATCH_MARKER} if wrong; anyway here is my plan.`,
		});
		expect(restated.mismatchDeclared).toBe(false);
		expect(restated.next.analysisDue).toBe(false);
	});

	test("second zero-progress round on the same pairing forces ANALYZE (PAIRING_MAX_REPEATS=1); progress resets", () => {
		const pairing: PairingState = { nodeId: "n", instrumentId: "i", repeats: 0 };
		const stuck = settleRound({
			program: programWith({}),
			prev: { pairing, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 0 },
			phase: attackPhase("n", "i"),
			lastAssistantText: "no lever",
			round: 2,
		});
		expect(stuck.pairingStuckForced).toBe(true);
		expect(stuck.next.analysisDue).toBe(true);
		const progressing = settleRound({
			program: programWith({
				journal: [{ round: 2, kind: "node_proved", nodeId: "n", description: "d", evidence: "e", at: 1 }],
			}),
			prev: { pairing, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 0 },
			phase: attackPhase("n", "i"),
			lastAssistantText: "done",
			round: 2,
		});
		expect(progressing.madeProgress).toBe(true);
		expect(progressing.pairingStuckForced).toBe(false);
	});

	test("refuting the attacked node triggers ANALYZE — refuting an unrelated old node does not", () => {
		const program = programWith({
			nodes: [{ id: "attacked", status: "refuted" } as never, { id: "other", status: "refuted" } as never],
			journal: [{ round: 3, kind: "node_refuted", nodeId: "other", description: "d", evidence: "e", at: 1 }],
		});
		const settled = settleRound({
			program,
			prev: { pairing: undefined, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 0 },
			phase: attackPhase("attacked", "i"),
			lastAssistantText: "",
			round: 3,
		});
		expect(settled.attackRefuted).toBe(false);
		expect(settled.next.analysisDue).toBe(false);
	});

	test("2nd zero-progress round in the same phase → phaseStuck forces ANALYZE (state machine, not prose)", () => {
		const phase = { kind: "extend", reason: "dag-settled" } as never;
		const base = { program: programWith({}), phase, lastAssistantText: "" };
		let s = settleRound({
			...base,
			round: 1,
			prev: { pairing: undefined, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 0 },
		});
		expect(s.phaseStuckForced).toBe(false);
		s = settleRound({
			...base,
			round: 2,
			prev: {
				pairing: undefined,
				phaseStuck: s.next.phaseStuck,
				analysisDue: false,
				roundsSinceProgress: s.next.roundsSinceProgress,
			},
		});
		expect(s.phaseStuckForced).toBe(true);
		expect(s.next.analysisDue).toBe(true);
	});

	test("zero-progress rounds accumulate across phases (INVENT↔ANALYZE never resets); beyond 6 still no terminal", () => {
		const invent = { kind: "invent", latestVersion: 0, barriers: [], reason: "no-calibrated-instrument" } as never;
		const analyze = { kind: "analyze", instrument: undefined, trigger: "explicit" } as never;
		const base = { program: programWith({}), lastAssistantText: "" };
		let s = settleRound({
			...base,
			phase: invent,
			round: 1,
			prev: { pairing: undefined, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 0 },
		});
		for (let round = 2; round <= 9; round++) {
			s = settleRound({ ...base, phase: round % 2 === 0 ? analyze : invent, round, prev: s.next });
			expect(s.next.roundsSinceProgress).toBe(round);
			expect(s).not.toHaveProperty("terminal");
		}
	});

	test("load-bearing progress resets the cross-phase counter — a prove stamped this round attributes correctly", () => {
		const progress = settleRound({
			program: programWith({
				journal: [{ round: 3, kind: "node_proved", nodeId: "n", description: "d", evidence: "e", at: 1 }],
			}),
			prev: { pairing: undefined, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 2 },
			phase: attackPhase("n", "i"),
			lastAssistantText: "done",
			round: 3,
		});
		expect(progress.madeProgress).toBe(true);
		expect(progress.next.roundsSinceProgress).toBe(0);
	});
});

describe("determinePhase: extend/replan phases (RH lesson: provable lemma chains never collapse into INVENT)", () => {
	const instrument = (id: string, version: number) =>
		({
			id,
			version,
			artifacts: [],
			recovers: [{ theorem: "T", check: { check: "command", description: "d", command: "true", expect_exit: 0 } }],
			novelty: { statement: "n", check: { check: "command", description: "d", command: "true", expect_exit: 0 } },
			status: "calibrated",
		}) as const;
	const node = (id: string, deps: string[] = [], status = "pending") =>
		({
			id,
			kind: "computation",
			title: id,
			statement: "s",
			dependsOn: deps,
			acceptance: { check: "command", description: "d", command: "true", expect_exit: 0 },
			status,
		}) as never;
	const prog = (nodes: unknown[], instruments: unknown[]) =>
		({
			objective: "o",
			criteria: [{ check: "command", description: "c", command: "false", expect_exit: 0 }],
			nodes,
			journal: [],
			instruments,
			barriers: [],
			status: "active",
			updatedAt: 0,
		}) as unknown as Program;

	test("all nodes settled + empty premiseSet → invent(frontier-drained); next instrument reopens the frontier", () => {
		const p = prog([node("a", [], "proved")], [instrument("i", 1)]);
		const phase = determinePhase(p, false);
		expect(phase).toMatchObject({ kind: "invent", reason: "frontier-drained" });
	});

	test("a refuted dependency makes children unreachable (blocked) → replan carries unreachable", () => {
		const p = prog([node("dep", [], "refuted"), node("child", ["dep"])], [instrument("i", 1)]);
		const phase = determinePhase(p, false);
		expect(phase.kind).toBe("replan");
		if (phase.kind === "replan") expect(phase.unreachable.map((n) => n.id)).toEqual(["child"]);
	});

	test("saturation ≥ 2 with empty targets: analysisDue no longer fires analyze — breakers are L0-only", () => {
		// all nodes proved → premiseSet/parked both empty → translate has no targets, the ladder falls
		// through to the L0 tail which must NOT honor analysisDue at saturation ≥ 2
		const p = prog([node("a", [], "proved")], [instrument("i", 1)]);
		const phase = determinePhase(p, true, 4);
		expect(phase.kind).not.toBe("analyze");
		expect(phase).toMatchObject({ kind: "invent", reason: "frontier-drained" });
		// L0 (rsp < 2) still honors analysisDue
		const l0 = determinePhase(prog([node("a")], [instrument("i", 1)]), true, 1);
		expect(l0).toMatchObject({ kind: "analyze", trigger: "explicit" });
	});
});

describe("roundMadeProgress (per-round, per-target attribution)", () => {
	const entry = (round: number, kind: string, nodeId?: string, instrumentId?: string) =>
		({ round, kind, nodeId, instrumentId, description: "d", evidence: "e", at: 1 }) as never;

	test("only entries stamped this round count as progress — last round's prove does not renew this round", () => {
		const p = programWith({
			journal: [entry(3, "node_proved", "n"), entry(4, "note", "n")],
		});
		expect(roundMadeProgress(p, 4, { nodeId: "n" })).toBe(false);
		expect(roundMadeProgress(p, 3, { nodeId: "n" })).toBe(true);
	});

	test("attributed to this round's target — an unrelated node's prove does not reset the attack breaker", () => {
		const p = programWith({
			journal: [entry(5, "node_proved", "unrelated")],
		});
		expect(roundMadeProgress(p, 5, { nodeId: "attacked" })).toBe(false);
		expect(roundMadeProgress(p, 5, { nodeId: "unrelated" })).toBe(true);
	});

	test("structural actions (nodes_added/park/restate) count without a target — they change the schedulable set", () => {
		const added = programWith({ journal: [entry(2, "nodes_added")] });
		expect(roundMadeProgress(added, 2)).toBe(true);
		const parked = programWith({ journal: [entry(2, "node_parked", "x")] });
		expect(roundMadeProgress(parked, 2, { nodeId: "other" })).toBe(true);
		const restated = programWith({ journal: [entry(2, "node_restated", "x")] });
		expect(roundMadeProgress(restated, 2)).toBe(true);
	});

	test("instrument attribution: another instrument's calibration/barrier does not reset; same instrument does", () => {
		const calibA = programWith({ journal: [entry(7, "instrument_calibrated", undefined, "toolA")] });
		expect(roundMadeProgress(calibA, 7, { nodeId: "n", instrumentId: "toolA" })).toBe(true);
		expect(roundMadeProgress(calibA, 7, { nodeId: "n", instrumentId: "toolB" })).toBe(false);
		expect(roundMadeProgress(calibA, 7, { nodeId: "n" })).toBe(false);
		const barrierSame = programWith({ journal: [entry(7, "barrier_recorded", undefined, "toolA")] });
		expect(roundMadeProgress(barrierSame, 7, { nodeId: "n", instrumentId: "toolA" })).toBe(true);
		const barrierOther = programWith({ journal: [entry(7, "barrier_recorded", undefined, "toolB")] });
		expect(roundMadeProgress(barrierOther, 7, { instrumentId: "toolA" })).toBe(false);
	});

	test("legacy entries without instrumentId: unattributable with an instrument target; count when targetless", () => {
		const legacy = programWith({ journal: [entry(7, "instrument_calibrated"), entry(8, "barrier_recorded")] });
		expect(roundMadeProgress(legacy, 7, { instrumentId: "i" })).toBe(false);
		expect(roundMadeProgress(legacy, 8, { instrumentId: "i" })).toBe(false);
		expect(roundMadeProgress(legacy, 7)).toBe(true);
		expect(roundMadeProgress(legacy, 8)).toBe(true);
	});

	test("undefined target (worker claim / invent / analyze rounds): any load-bearing entry counts as progress", () => {
		// every load-bearing kind must credit here, or the saturation ladder climbs to permanent epoch
		expect(roundMadeProgress(programWith({ journal: [entry(9, "node_proved", "n")] }), 9)).toBe(true);
		expect(roundMadeProgress(programWith({ journal: [entry(9, "instrument_calibrated")] }), 9)).toBe(true);
		expect(roundMadeProgress(programWith({ journal: [entry(9, "barrier_recorded")] }), 9)).toBe(true);
		// the round stamp still gates: a DIFFERENT round's entry never counts
		expect(roundMadeProgress(programWith({ journal: [entry(8, "node_proved", "n")] }), 9)).toBe(false);
		// context-only kinds stay non-progress even without a target
		expect(roundMadeProgress(programWith({ journal: [entry(9, "note", "n")] }), 9)).toBe(false);
		expect(roundMadeProgress(programWith({ journal: [entry(9, "node_started", "n")] }), 9)).toBe(false);
	});

	test("targeted round with non-matching nodeId keeps attribution semantics (audit #6, no cross-attribution)", () => {
		const p = programWith({ journal: [entry(6, "node_proved", "unrelated")] });
		expect(roundMadeProgress(p, 6, { nodeId: "attacked" })).toBe(false);
		expect(roundMadeProgress(p, 6, { nodeId: "unrelated" })).toBe(true);
	});
});

describe("failed-ledger replay (01a003a7 endgame: notes with nodeId never count as progress)", () => {
	const replay = programWith({
		nodes: [
			{
				id: "offline-zero-cert",
				kind: "computation",
				title: "offline zero certificate",
				statement: "s",
				dependsOn: [],
				acceptance: { check: "command", description: "d", command: "true", expect_exit: 0 },
				status: "pending",
			} as never,
		],
		journal: [
			{ round: 13, kind: "note", nodeId: "offline-zero-cert", description: "searched boxes", evidence: "e", at: 1 },
			{
				round: 14,
				kind: "note",
				nodeId: "offline-zero-cert",
				description: "searched more boxes",
				evidence: "e",
				at: 2,
			},
		] as never,
	});
	const attack = attackPhase("offline-zero-cert", "zero-locator");
	const base = { program: replay, phase: attack, lastAssistantText: "searched 125 boxes; no counterexample yet" };

	test("note-only rounds: madeProgress=false → roundsSinceProgress climbs, saturation ladder rotates", () => {
		let prev: SettleState = { pairing: undefined, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 0 };
		let settled = settleRound({ ...base, round: 13, prev });
		expect(settled.madeProgress).toBe(false);
		expect(settled.next.roundsSinceProgress).toBe(1);

		prev = settled.next;
		settled = settleRound({ ...base, round: 14, prev });
		expect(settled.madeProgress).toBe(false);
		expect(settled.next.roundsSinceProgress).toBe(2);
		const l1 = determinePhase(replay, false, settled.next.roundsSinceProgress);
		expect(l1).toMatchObject({ kind: "reform", mode: "weaken", saturation: 1 });

		prev = settled.next;
		settled = settleRound({ ...base, round: 15, prev });
		settled = settleRound({ ...base, round: 16, prev: settled.next });
		expect(settled.next.roundsSinceProgress).toBe(4);
		const l2 = determinePhase(replay, false, settled.next.roundsSinceProgress);
		expect(l2).toMatchObject({ kind: "reform", mode: "translate", saturation: 2 });
		if (l2.kind === "reform" && l2.mode === "translate") {
			expect(l2.targets.map((n) => n.id)).toContain("offline-zero-cert");
		}

		settled = settleRound({ ...base, round: 17, prev: settled.next });
		expect(settled.next.roundsSinceProgress).toBe(5);
		settled = settleRound({ ...base, round: 18, prev: settled.next });
		expect(settled.next.roundsSinceProgress).toBe(6);
		const epoch = determinePhase(replay, false, settled.next.roundsSinceProgress);
		expect(epoch).toMatchObject({ kind: "epoch", saturation: 3 });
		if (epoch.kind === "epoch") expect(epoch.focuses).toEqual(["instrument"]);
	});
});

describe("saturation ladder scheduling (ladder + pairing refusal + archive recovery)", () => {
	const instrument = (id: string, version: number, status = "calibrated") =>
		({
			id,
			version,
			artifacts: [],
			recovers: [{ theorem: "T", check: { check: "command", description: "d", command: "true", expect_exit: 0 } }],
			novelty: { statement: "n", check: { check: "command", description: "d", command: "true", expect_exit: 0 } },
			status,
		}) as never;
	const node = (id: string, over: Record<string, unknown> = {}) =>
		({
			id,
			kind: "computation",
			title: id,
			statement: "s",
			dependsOn: [],
			acceptance: { check: "command", description: "d", command: "true", expect_exit: 0 },
			status: "pending",
			...over,
		}) as never;
	const prog = (nodes: unknown[], instruments: unknown[]) =>
		programWith({ nodes: nodes as never, instruments: instruments as never });

	test("roundsSinceProgress 1 → no escalation (normal phase proceeds)", () => {
		const p = prog([node("n1")], [instrument("i", 1)]);
		expect(determinePhase(p, false, 1).kind).toBe("attack");
	});

	test("uncalibrated declared instrument → analyze(pairing-refused); declared-or-latest fallback removed", () => {
		const p = prog(
			[node("n1", { instrumentId: "draft-tool" })],
			[instrument("i", 1), instrument("draft-tool", 2, "draft")],
		);
		const phase = determinePhase(p, false);
		expect(phase).toMatchObject({ kind: "analyze", trigger: "pairing-refused" });
	});

	test("ready empty, parked>0 → reform weaken (archive return is axis work, not INVENT collapse)", () => {
		const p = prog([node("n1", { status: "parked" }), node("done", { status: "proved" })], [instrument("i", 1)]);
		const phase = determinePhase(p, false);
		expect(phase).toMatchObject({ kind: "reform", mode: "weaken", saturation: 1 });
	});

	test("empty frontier (no ready, no parked, no open leaf) → invent(frontier-drained)", () => {
		const p = prog([node("done", { status: "proved" })], [instrument("i", 1)]);
		const phase = determinePhase(p, false);
		expect(phase).toMatchObject({ kind: "invent", reason: "frontier-drained" });
	});
});
