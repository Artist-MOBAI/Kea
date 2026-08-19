import { roundMadeProgress } from "./ledger.ts";
import {
	instrumentMismatchDeclared,
	type PairingState,
	type PhaseDecision,
	type PhaseStuckState,
	pairingStuck,
	phaseStuck,
} from "./scheduler.ts";
import type { Program } from "./schema.ts";

// Shared round settlement — single source of truth for the headless loop and the TUI auto-continue:
// both paths must judge a finished round identically. Pure function: no IO, no kernel access.

export interface SettleState {
	/** Pairing circuit-breaker state; undefined after non-attack rounds (they reset the baseline). */
	pairing: PairingState | undefined;
	/** Phase-stuck circuit-breaker state (same phase, zero progress). */
	phaseStuck: PhaseStuckState | undefined;
	/** ANALYZE is due next round (refutation / mismatch / pairing / phase-stuck; plus the loop-level semantic judge on zero-progress rounds). */
	analysisDue: boolean;
	/** Consecutive zero-progress rounds ACROSS phases — phase alternation must NOT reset this. */
	roundsSinceProgress: number;
}

export interface SettleInput {
	/** The program as reloaded AFTER the round's work (progress is read from this journal). */
	program: Program;
	prev: SettleState;
	phase: PhaseDecision;
	lastAssistantText: string;
	round: number;
}

export interface SettleResult {
	next: SettleState;
	madeProgress: boolean;
	attackRefuted: boolean;
	mismatchDeclared: boolean;
	pairingStuckForced: boolean;
	phaseStuckForced: boolean;
}

export function settleRound(input: SettleInput): SettleResult {
	const { program, prev, phase, lastAssistantText, round } = input;

	const target = phase.kind === "attack" ? { nodeId: phase.node.id, instrumentId: phase.instrument.id } : undefined;
	const madeProgress = roundMadeProgress(program, round, target);

	// Grows unbounded and never produces a terminal: the scheduler maps its depth onto the escalation
	// ladder; only machine-verified criteria settle complete.
	const roundsSinceProgress = madeProgress ? 0 : prev.roundsSinceProgress + 1;

	// only refuting the ATTACKED node ends this attack — an unrelated refutation this round is
	// re-planning input, not the end of this attack
	const attackRefuted =
		phase.kind === "attack" &&
		program.nodes.some(
			(n) =>
				n.id === phase.node.id &&
				n.status === "refuted" &&
				// the journal entry must belong to THIS node — refuting an unrelated node this round is
				// re-planning input, not the end of this attack
				program.journal.some((e) => e.round === round && e.kind === "node_refuted" && e.nodeId === n.id),
		);

	let mismatchDeclared = false;
	let pairingStuckForced = false;
	let pairing = prev.pairing;
	if (phase.kind === "attack") {
		mismatchDeclared = instrumentMismatchDeclared(lastAssistantText);
		const decision = pairingStuck(
			prev.pairing,
			{ nodeId: phase.node.id, instrumentId: phase.instrument.id },
			madeProgress,
		);
		pairing = decision.state;
		pairingStuckForced = decision.forceAnalyze;
	} else {
		pairing = undefined; // non-attack rounds reset the pairing baseline
	}

	// Phase-stuck judges only the ledger, never the model's prose. The key is phase kind + reform
	// mode: weaken and translate are both kind "reform", so kind-only keys would misread the L1→L2
	// switch as stuck after a single round.
	const stuck = phaseStuck(
		prev.phaseStuck,
		phase.kind === "reform" ? `reform:${phase.mode}` : phase.kind,
		madeProgress,
	);
	const phaseStuckForced = stuck.forceAnalyze;

	const analysisDue = attackRefuted || mismatchDeclared || pairingStuckForced || phaseStuckForced;
	return {
		next: { pairing, phaseStuck: stuck.state, analysisDue, roundsSinceProgress },
		madeProgress,
		attackRefuted,
		mismatchDeclared,
		pairingStuckForced,
		phaseStuckForced,
	};
}

export function lastAssistantTextOf(
	messages: Array<{ role?: string; content?: Array<{ type: string; text?: string }> }>,
): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		const text = (m.content ?? [])
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("");
		if (text.trim() !== "") return text;
	}
	return "";
}
