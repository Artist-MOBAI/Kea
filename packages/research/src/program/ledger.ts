import type { JournalEntry, Program } from "./schema.ts";

// Load-bearing accounting: membership in this CLOSED op-kind set is the only progress signal the loop
// trusts. `note`/`calibration`/`node_started` are context, never progress — narration about a node is
// not work on it, and starting is not finishing.
export const LOAD_BEARING_KINDS = new Set<JournalEntry["kind"]>([
	"node_proved",
	"node_refuted",
	"node_parked",
	"node_restated",
	"nodes_added",
	"instrument_calibrated",
	"barrier_recorded",
]);

export function isLoadBearing(entry: JournalEntry): boolean {
	return LOAD_BEARING_KINDS.has(entry.kind);
}

// counts entries strictly after sinceIndex (−1 = count all)
export function loadBearingSince(program: Program, sinceIndex = -1): number {
	let count = 0;
	for (let i = sinceIndex + 1; i < program.journal.length; i++) {
		if (isLoadBearing(program.journal[i] ?? ({ nodeId: undefined } as JournalEntry))) count++;
	}
	return count;
}

export function lastLoadBearingIndex(program: Program): number {
	for (let i = program.journal.length - 1; i >= 0; i--) {
		const entry = program.journal[i];
		if (entry !== undefined && isLoadBearing(entry)) return i;
	}
	return -1;
}

// Per-round, per-target attribution: with a target, only ops attributed to the scheduled
// node/instrument (or structural park/restate/nodes_added) count; without a target (worker-claimed
// rechecks, invent/analyze rounds), any load-bearing entry stamped with the round counts — fresh-worker
// output must be credited or the saturation ladder climbs to permanent epoch.
export function roundMadeProgress(
	program: Program,
	round: number,
	target?: { nodeId?: string; instrumentId?: string },
): boolean {
	const unattributed = target === undefined || (target.nodeId === undefined && target.instrumentId === undefined);
	for (const entry of program.journal) {
		if (entry.round !== round || !isLoadBearing(entry)) continue;
		if (unattributed) return true;
		if (entry.kind === "nodes_added" || entry.kind === "node_parked" || entry.kind === "node_restated") return true;
		if (target?.nodeId !== undefined && entry.nodeId === target.nodeId) return true;
		// instrument attribution: only work on the TARGET instrument counts — an unrelated instrument's
		// calibration/barrier this round must not reset the attack breaker; unstamped (legacy) entries
		// are not attributable either
		if (
			target?.instrumentId !== undefined &&
			(entry.kind === "instrument_calibrated" || entry.kind === "barrier_recorded") &&
			entry.instrumentId === target.instrumentId
		)
			return true;
	}
	return false;
}

export function recentLoadBearing(program: Program, limit = 5): JournalEntry[] {
	return program.journal.filter(isLoadBearing).slice(-limit);
}
