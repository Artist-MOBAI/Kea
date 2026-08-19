import { downstreamDepth, parkedNodes, premiseSet, readyNodes, unreachableNodes } from "./graph.ts";
import type { Program, ProgramNode } from "./schema.ts";

// Pure scheduler: decide the next round's directive. Saturation ladder first (stagnation escalates
// the exploration axis — weaken → translate → blank epoch workers — never a terminal; the only
// machine terminal is `complete`), then critical-path attack among ready nodes, declared-instrument
// pairing (uncalibrated declared instrument → refuse), blocked → replan, empty frontier → reform/extend.

export type SchedulingDecision =
	| { kind: "node"; node: ProgramNode; readyCount: number }
	| { kind: "blocked"; unreachable: ProgramNode[] }
	| { kind: "empty" };

export function pickNext(program: Program): SchedulingDecision {
	const ready = readyNodes(program);
	if (ready.length > 0) {
		let best = ready[0] as ProgramNode;
		let bestDepth = downstreamDepth(program, best.id);
		for (const candidate of ready.slice(1)) {
			const depth = downstreamDepth(program, candidate.id);
			if (depth > bestDepth) {
				best = candidate;
				bestDepth = depth;
			}
		}
		return { kind: "node", node: best, readyCount: ready.length };
	}
	const unreachable = unreachableNodes(program);
	if (unreachable.length > 0) return { kind: "blocked", unreachable };
	return { kind: "empty" };
}

export type SaturationLevel = 0 | 1 | 2 | 3;

export const EPOCH_FOCUSES = ["instrument", "domain", "structure", "survey"] as const;
export type EpochFocus = (typeof EPOCH_FOCUSES)[number];

export const SATURATION_L1_ROUNDS = 2;
export const SATURATION_L2_ROUNDS = 4;
export const EPOCH_ROUNDS = 6;

export type PhaseDecision =
	| {
			kind: "invent";
			latestVersion: number;
			barriers: Program["barriers"];
			reason: "no-calibrated-instrument" | "frontier-drained";
	  }
	| { kind: "attack"; instrument: Program["instruments"][number]; node: ProgramNode }
	| {
			kind: "analyze";
			instrument: Program["instruments"][number] | undefined;
			trigger: "refuted-attack" | "pairing-refused" | "explicit" | "phase-stuck";
	  }
	| {
			kind: "reform";
			mode: "weaken";
			saturation: 1;
	  }
	| {
			kind: "reform";
			mode: "translate";
			saturation: 2;
			targets: ProgramNode[];
	  }
	| {
			/** rsp ≥ 6: the round's work goes to BLANK fresh workers (zero parent context), not an in-session prompt. */
			kind: "epoch";
			saturation: 3;
			focuses: EpochFocus[];
			targets: ProgramNode[];
	  }
	| { kind: "extend"; reason: "dag-settled" }
	| { kind: "replan"; unreachable: ProgramNode[] };

export function epochFocuses(roundsSinceProgress: number): EpochFocus[] {
	const base = roundsSinceProgress - EPOCH_ROUNDS;
	const width = roundsSinceProgress >= 18 ? 3 : roundsSinceProgress >= 12 ? 2 : 1;
	const pick = (i: number): EpochFocus => {
		const focus = EPOCH_FOCUSES[(base + i) % EPOCH_FOCUSES.length];
		return focus === undefined ? EPOCH_FOCUSES[0] : focus; // unreachable: base ≥ 0, modulo in range
	};
	return Array.from({ length: width }, (_, i) => pick(i));
}

export function saturationOf(roundsSinceProgress: number): SaturationLevel {
	if (roundsSinceProgress >= EPOCH_ROUNDS) return 3;
	if (roundsSinceProgress >= SATURATION_L2_ROUNDS) return 2;
	if (roundsSinceProgress >= SATURATION_L1_ROUNDS) return 1;
	return 0;
}

export function determinePhase(program: Program, analysisDue: boolean, roundsSinceProgress = 0): PhaseDecision {
	const calibrated = program.instruments.filter((i) => i.status === "calibrated").sort((a, b) => a.version - b.version);
	const latest = calibrated[calibrated.length - 1];
	const saturation = saturationOf(roundsSinceProgress);

	// Saturation-first: analysisDue never preempts the ladder — the zero-progress counter alone
	// escalates (rsp 0-1 normal phases, 2-3 weaken, 4-5 translate, ≥6 epoch; never a terminal).
	if (saturation >= 3) {
		const seen = new Set<string>();
		const targets = [...premiseSet(program), ...parkedNodes(program)].filter((n) => {
			if (seen.has(n.id)) return false;
			seen.add(n.id);
			return true;
		});
		return { kind: "epoch", saturation: 3, focuses: epochFocuses(roundsSinceProgress), targets };
	}
	if (saturation >= 2) {
		const seen = new Set<string>();
		const targets = [...premiseSet(program), ...parkedNodes(program)].filter((n) => {
			if (seen.has(n.id)) return false;
			seen.add(n.id);
			return true;
		});
		if (targets.length > 0) return { kind: "reform", mode: "translate", saturation: 2, targets };
	}

	if (saturation === 1) {
		return { kind: "reform", mode: "weaken", saturation: 1 };
	}

	// explicit breakers only fire at L0 — inside the ladder the counter itself is the escalation signal
	if (analysisDue && saturation === 0) {
		return { kind: "analyze", instrument: latest, trigger: "explicit" };
	}

	if (latest === undefined) {
		return {
			kind: "invent",
			latestVersion: program.instruments.reduce((m, i) => Math.max(m, i.version), 0),
			barriers: program.barriers,
			reason: "no-calibrated-instrument",
		};
	}

	const decision = pickNext(program);
	if (decision.kind === "node") {
		// Pairing discipline: the node's DECLARED instrument when calibrated — otherwise REFUSE the
		// pairing (no declared-or-latest fallback).
		if (decision.node.instrumentId !== undefined) {
			const declared = calibrated.find((i) => i.id === decision.node.instrumentId);
			if (declared === undefined) {
				return { kind: "analyze", instrument: latest, trigger: "pairing-refused" };
			}
			return { kind: "attack", instrument: declared, node: decision.node };
		}
		return { kind: "attack", instrument: latest, node: decision.node };
	}
	// blocked and empty are DIFFERENT jobs and must not collapse into INVENT: blocked → REPLAN;
	// empty → EXTEND, or REFORM when the only live structure is the parked archive.
	if (decision.kind === "blocked") {
		return { kind: "replan", unreachable: decision.unreachable };
	}
	if (parkedNodes(program).length > 0) {
		return { kind: "reform", mode: "weaken", saturation: 1 };
	}
	const frontier = premiseSet(program);
	if (frontier.length === 0 && calibrated.length > 0) {
		return {
			kind: "invent",
			latestVersion: program.instruments.reduce((m, i) => Math.max(m, i.version), 0),
			barriers: program.barriers,
			reason: "frontier-drained",
		};
	}
	return { kind: "extend", reason: "dag-settled" };
}

export interface PairingState {
	nodeId: string;
	instrumentId: string;
	repeats: number;
}

// A pairing mismatch is neither a refusal nor a refutation — nothing else flips the phase — so after
// maxRepeats consecutive zero-progress rounds on the same pairing the loop must ANALYZE instead of
// scheduling the identical attack. 1 = the second consecutive zero-progress round already forces it.
export const PAIRING_MAX_REPEATS = 1;

export function pairingStuck(
	prev: PairingState | undefined,
	next: { nodeId: string; instrumentId: string },
	madeProgress: boolean,
): { state: PairingState | undefined; forceAnalyze: boolean } {
	const samePair = prev !== undefined && prev.nodeId === next.nodeId && prev.instrumentId === next.instrumentId;
	if (madeProgress) {
		return { state: { ...next, repeats: 0 }, forceAnalyze: false };
	}
	const repeats = samePair ? prev.repeats + 1 : 0;
	return { state: { ...next, repeats }, forceAnalyze: repeats >= PAIRING_MAX_REPEATS };
}

// Phase-stuck circuit breaker: the same phase making zero load-bearing progress for consecutive rounds
// must not spin — force ANALYZE. Judged purely from ledger progress, never from prose.
export interface PhaseStuckState {
	phaseKind: string;
	repeats: number;
}

export const PHASE_STUCK_MAX_REPEATS = 1;

export function phaseStuck(
	prev: PhaseStuckState | undefined,
	phaseKind: string,
	madeProgress: boolean,
): { state: PhaseStuckState | undefined; forceAnalyze: boolean } {
	if (madeProgress) {
		return { state: { phaseKind, repeats: 0 }, forceAnalyze: false };
	}
	const samePhase = prev !== undefined && prev.phaseKind === phaseKind;
	const repeats = samePhase ? prev.repeats + 1 : 0;
	return { state: { phaseKind, repeats }, forceAnalyze: repeats >= PHASE_STUCK_MAX_REPEATS };
}

/** Machine-readable mismatch verdict the ATTACK prompt asks for when an instrument has no lever on a node. */
export const INSTRUMENT_MISMATCH_MARKER = "INSTRUMENT_MISMATCH";

// The prompt contract asks the model to END its reply with the marker line — match the LAST non-empty
// line exactly, not a substring anywhere (mid-analysis restatements must not trigger the switch).
export function instrumentMismatchDeclared(roundText: string): boolean {
	const lines = roundText.trimEnd().split("\n");
	const last = lines[lines.length - 1]?.trim() ?? "";
	return last === INSTRUMENT_MISMATCH_MARKER;
}
