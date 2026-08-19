// Trimmed content is merely no longer rendered — the full data lives in the session ledger
// (replay/export as the fallback).

export const TRANSCRIPT_MAX_TURNS = 15;
export const TRANSCRIPT_HYSTERESIS = 5;
export const KEEP_RECENT_STEPS = 30;

// Only act past max+hysteresis (avoid per-turn jitter), trimming down to max;
// the most recent turn is never trimmed.
export function turnsToTrim(
	turnCount: number,
	maxTurns = TRANSCRIPT_MAX_TURNS,
	hysteresis = TRANSCRIPT_HYSTERESIS,
): number {
	if (turnCount <= maxTurns + hysteresis) return 0;
	const remove = turnCount - maxTurns;
	return Math.min(remove, Math.max(0, turnCount - 1));
}
