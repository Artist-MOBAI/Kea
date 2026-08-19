import type { Critique, Distill, FinalPlan, Judge } from "./schemas.ts";

// Self-consistency validation: a second layer ABOVE the zod schema — zod guarantees shape, these
// functions guarantee the fields agree with each other. A failed decision is recorded and retried
// once, never silently dropped.

export interface ValidationResult {
	ok: boolean;
	reason?: string;
}

export function validateDistill(distill: Distill): ValidationResult {
	const factorIds = new Set<string>();
	for (const f of distill.critical_factors) {
		if (factorIds.has(f.id)) return { ok: false, reason: `duplicate critical factor id "${f.id}"` };
		factorIds.add(f.id);
	}
	const hypIds = new Set<string>();
	for (const h of distill.hypotheses) {
		if (hypIds.has(h.id)) return { ok: false, reason: `duplicate hypothesis id "${h.id}"` };
		hypIds.add(h.id);
	}
	return { ok: true };
}

export function validateCritique(critique: Critique): ValidationResult {
	if (critique.verdict === "reject" && critique.weaknesses.length === 0) {
		return { ok: false, reason: "critic rejected a plan but gave no weaknesses (a rejection must be actionable)" };
	}
	if (critique.verdict === "keep" && critique.strengths.length === 0 && critique.weaknesses.length === 0) {
		return { ok: false, reason: "critic kept a plan but gave neither strengths nor weaknesses" };
	}
	return { ok: true };
}

export function validateJudge(judge: Judge, candidateIds: readonly string[]): ValidationResult {
	if (!candidateIds.includes(judge.winner_id)) {
		return { ok: false, reason: `judge winner_id "${judge.winner_id}" is not among the candidates` };
	}
	if (!judge.converged && judge.gaps.length === 0) {
		return { ok: false, reason: "judge said not converged but gave no gaps (what remains to resolve?)" };
	}
	return { ok: true };
}

export function validateFinalPlan(plan: FinalPlan): ValidationResult {
	if (plan.falsification_criterion.trim() === "") {
		return { ok: false, reason: "final plan missing a falsification criterion" };
	}
	return { ok: true };
}

/** Anti-optimistic-stop nudge for a plan missing a falsification criterion or next hypothesis (undefined when complete). */
export function assertFinalPlanComplete(plan: FinalPlan): string | undefined {
	const missing: string[] = [];
	if (plan.falsification_criterion.trim() === "") missing.push("a falsification criterion");
	if (plan.next_hypotheses.length === 0) missing.push("at least one next hypothesis for the following round");
	if (missing.length === 0) return undefined;
	return [
		`The final plan is incomplete: it is missing ${missing.join(" and ")}.`,
		"Add them before submitting — a science plan without a falsification criterion or a next step cannot be verified or iterated.",
	].join(" ");
}
