import { mapPooled, type SubagentResult, type SubagentRunner, untrustedObjectiveBlock } from "@kea/core";
import { type ZodSchema, z } from "zod";
import {
	type Angle,
	type CriticalFactor,
	type Critique,
	CritiqueSchema,
	DistillSchema,
	type FinalPlan,
	FinalPlanSchema,
	type Judge,
	JudgeSchema,
	type Plan,
	PlanSchema,
} from "./schemas.ts";
import {
	assertFinalPlanComplete,
	validateCritique,
	validateDistill,
	validateFinalPlan,
	validateJudge,
} from "./validate.ts";

// Recursive hypothesis search: distill the critical factors, then iteratively diverge (planner per
// hypothesis) → adversarial critique → independent judge → prune (rejected weaknesses and unresolved
// gaps reflow into the next frontier) → synthesize survivors into one judge-selected final plan.
// Discipline: no fixed caps (model/budget driven); FatalOrchestrationError ends the whole run while a
// bad path degrades to a per-item error; every phase output passes a self-consistency check — invalid
// decisions are recorded, never trusted; a final plan missing a falsification criterion or next
// hypothesis is flagged, never silently emitted.

/** A whole-run failure (budget/cancel/infra). Distinct from a per-path failure, which degrades to an error on that path. */
export class FatalOrchestrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FatalOrchestrationError";
	}
}

/** Extract a validated JSON value from a subagent's free-text final message (whole / fenced / first balanced object). */
export function extractJson<T>(text: string, schema: ZodSchema<T>): T | undefined {
	const trimmed = text.trim();
	try {
		return schema.parse(JSON.parse(trimmed));
	} catch {}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	const fencedBody = fenced?.[1]?.trim();
	if (fencedBody) {
		try {
			return schema.parse(JSON.parse(fencedBody));
		} catch {}
	}
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			return schema.parse(JSON.parse(trimmed.slice(start, end + 1)));
		} catch {}
	}
	return undefined;
}

export interface ScienceRunOptions {
	/** pre-supplied hypotheses (skip the distill phase); each string becomes one hypothesis */
	angles?: string[];
	/** max parallel subagents per phase (default = the phase's item count; no hardcoded constant) */
	maxConcurrency?: number;
	/** hard cap on total subagent calls across the whole run; exceeding it is a FatalOrchestrationError */
	maxCalls?: number;
	/** beam width: keep the top-`keep` plans (by judge score) and synthesize `keep` candidates; omit = no pruning, one candidate */
	keep?: number;
	signal?: AbortSignal;
	onProgress?: (line: string) => void;
}

export interface TraceEntry {
	round: number;
	diverged: number;
	critiqued: number;
	kept: number;
	rejected: number;
	reflowed: number;
	converged: boolean;
}

export interface SciencePlanRun {
	runId: string;
	angles: Angle[];
	/** critical factors distilled from the problem (empty when pre-supplied angles skip distill) */
	factors: CriticalFactor[];
	plans: Array<{ angle: Angle; plan?: Plan; error?: string }>;
	critiques: Array<{ angleId: string; critique?: Critique; error?: string }>;
	finalPlan?: FinalPlan;
	/** anti-optimistic-stop nudge (set when the final plan lacks a falsification criterion or next hypothesis) */
	nudge?: string;
	error?: string;
	trace: TraceEntry[];
	overhead: { subagentCalls: number };
}

const DISTILL_PROMPT = (problem: string): string =>
	[
		"Distill this scientific problem into its critical factors and initial hypotheses.",
		"",
		"For each critical factor, state:",
		"- `factor` — what matters most",
		"- `why_critical` — why it is decisive",
		"- `north_star_metric` — the world-best metric",
		"- `current_sota` — the baseline to beat",
		"Pick however many factors are genuinely decisive; there is no fixed count.",
		"",
		"Propose orthogonal hypotheses: one risky, one conservative, one novelty-seeking.",
		"",
		untrustedObjectiveBlock(problem),
		"",
		'Reply with JSON only: {"critical_factors":[{"id":"...","factor":"...","why_critical":"...","north_star_metric":"...","current_sota":"..."}], "hypotheses":[{"id":"...","hypothesis":"...","approach":"...","sub_questions":["..."],"evidence_needs":["..."]}]}.',
	].join("\n");

const PLANNER_PROMPT = (problem: string, angle: Angle, siblings: Angle[]): string =>
	[
		"Plan one complete, falsifiable approach for your angle.",
		"",
		"- Delegate investigation to subagents as needed; synthesize their evidence.",
		"- Every load-bearing claim needs a source or a concrete check.",
		...(siblings.length > 0
			? [
					`- Make it meaningfully different from the sibling angles: ${JSON.stringify(siblings.map((s) => s.hypothesis))}.`,
				]
			: []),
		"",
		untrustedObjectiveBlock(problem),
		`Your angle (${angle.id}): ${JSON.stringify({ hypothesis: angle.hypothesis, approach: angle.approach, sub_questions: angle.sub_questions })}`,
		"",
		'Reply with JSON only: {"objective":"...","method":"...","validation":"...","falsification_criterion":"...","risks":["..."],"fallback":"..."}.',
	].join("\n");

const CRITIC_PROMPT = (plan: Plan): string =>
	[
		"Adversarially critique this plan: find where it fails, not where it holds.",
		"",
		"- Grade it on falsifiability, novelty, feasibility, and coverage.",
		"- A reject must be actionable (non-empty weaknesses); a keep must cite at least one concrete strength or weakness.",
		"",
		`Plan:\n${JSON.stringify(plan, null, 2)}`,
		"",
		'Reply with JSON only: {"verdict":"keep"|"reject","fatal":true|false,"strengths":["..."],"weaknesses":["..."],"novelty":"novel"|"known"|"unverified","recommendation":"..."}.',
	].join("\n");

const JUDGE_PROMPT = (entries: Array<{ angle: Angle; plan: Plan; critique?: Critique }>): string =>
	[
		"Score each candidate plan and decide whether exploration has converged.",
		"",
		"- Score on falsifiability, novelty, feasibility, and coverage of the critical factors (0-10).",
		"- Pick the single best candidate as `winner_id`.",
		"- `converged` is true only when the winner is strong enough and no important gap remains; otherwise `gaps` is non-empty.",
		"",
		"Candidates:",
		entries
			.map((e) => `[${e.angle.id}]\n${JSON.stringify({ plan: e.plan, critique: e.critique }, null, 2)}`)
			.join("\n\n"),
		"",
		'Reply with JSON only: {"winner_id":"<angle id>","scores":[{"id":"<angle id>","score":<0-10>,"rationale":"..."}],"converged":true|false,"gaps":["..."]}.',
	].join("\n");

const SYNTHESIZER_PROMPT = (
	kept: Array<{ angle: Angle; plan: Plan; critique?: Critique }>,
	critiques: Array<{ angleId: string; critique: Critique }>,
): string =>
	[
		"Synthesize the kept plans into one final plan.",
		"",
		"- Merge the best parts and resolve contradictions: keep the direction with stronger evidence and say why you discarded the rest.",
		"- Keep the falsification criterion. Account for every discarded plan in `discarded_rationale`.",
		"- Propose `next_hypotheses` for the next round after this plan executes.",
		"",
		`Kept plans:\n${JSON.stringify(kept, null, 2)}`,
		`Critiques:\n${JSON.stringify(critiques, null, 2)}`,
		"",
		'Reply with JSON only: {"objective":"...","method":"...","validation":"...","falsification_criterion":"...","risks":["..."],"fallback":"...","discarded_rationale":"...","next_hypotheses":["..."]}.',
	].join("\n");

const FINAL_PICK_PROMPT = (candidates: FinalPlan[]): string =>
	[
		"Pick the single best synthesized plan.",
		"",
		candidates.map((c, i) => `### Candidate ${i}\n${JSON.stringify(c, null, 2)}`).join("\n\n"),
		"",
		'Reply with JSON only: {"winner_index": <integer index of the best candidate>}.',
	].join("\n");

const FinalPickSchema = z.object({ winner_index: z.number().int().min(0) });

export class ScienceOrchestrator {
	constructor(private readonly runner: SubagentRunner) {}

	async run(problem: string, opts: ScienceRunOptions = {}): Promise<SciencePlanRun> {
		const runId = `sci-${Date.now().toString(36)}`;
		const progress = opts.onProgress ?? (() => {});
		const trace: TraceEntry[] = [];
		let calls = 0;
		let initial: Angle[] = [];
		let factors: CriticalFactor[] = [];
		const allPlans: Array<{ angle: Angle; plan?: Plan; error?: string }> = [];
		const allCritiques: Array<{ angleId: string; critique?: Critique; error?: string }> = [];

		/** run one subagent, honoring the whole-run call budget and abort; budget/abort are fatal, other errors are per-item. */
		const runSubagent = async (task: string, profile: string): Promise<SubagentResult> => {
			if (opts.signal?.aborted) throw new FatalOrchestrationError("aborted");
			if (opts.maxCalls !== undefined && calls >= opts.maxCalls) {
				throw new FatalOrchestrationError(`orchestration call budget exhausted (${opts.maxCalls} calls)`);
			}
			calls += 1;
			return this.runner.run({ task, profile, signal: opts.signal });
		};

		try {
			progress("phase 0: distill");
			if (opts.angles && opts.angles.length > 0) {
				initial = opts.angles.map((a, i) => ({
					id: `angle-${i + 1}`,
					hypothesis: a,
					approach: a,
					sub_questions: [a],
					evidence_needs: [],
				}));
			} else {
				let distill = extractJson((await runSubagent(DISTILL_PROMPT(problem), "reader")).summary, DistillSchema);
				if (!distill || !validateDistill(distill).ok) {
					// parse or self-consistency failure: retry once with the concrete reason
					const reason = distill ? (validateDistill(distill).reason ?? "internally inconsistent") : "invalid JSON";
					distill = extractJson(
						(
							await runSubagent(
								DISTILL_PROMPT(problem) +
									`\n\nYour previous output was rejected (${JSON.stringify(reason)}); return valid JSON with distinct factor and hypothesis ids.`,
								"reader",
							)
						).summary,
						DistillSchema,
					);
					// a retry that STILL fails self-consistency is rejected, never silently adopted
					if (distill && !validateDistill(distill).ok) distill = undefined;
				}
				if (!distill) {
					return {
						runId,
						angles: [],
						factors: [],
						plans: [],
						critiques: [],
						error: "distill produced no usable factors/hypotheses",
						trace,
						overhead: { subagentCalls: calls },
					};
				}
				factors = distill.critical_factors;
				initial = distill.hypotheses;
			}

			let frontier = [...initial];
			const exploredHypotheses = new Set(initial.map((h) => h.hypothesis));
			const keptPlans: Array<{ angle: Angle; plan: Plan; critique?: Critique; score?: number }> = [];
			let judgeConverged = false;
			let round = 0;

			while (frontier.length > 0 && !judgeConverged) {
				round += 1;
				progress(`phase 1: diverge round ${round} (${frontier.length} hypotheses)`);

				const planResults = await mapPooled(
					frontier,
					opts.maxConcurrency ?? frontier.length,
					async (angle, index) => {
						const siblings = frontier.filter((_, j) => j !== index);
						const result = await runSubagent(PLANNER_PROMPT(problem, angle, siblings), "planner");
						const plan = extractJson(result.summary, PlanSchema);
						return { angle, plan, error: plan ? undefined : (result.error ?? "planner returned invalid JSON") };
					},
					opts.signal,
				);
				for (const p of planResults) allPlans.push(p);
				const validPlans: Array<{ angle: Angle; plan: Plan }> = planResults.flatMap((p) =>
					p.plan ? [{ angle: p.angle, plan: p.plan }] : [],
				);

				progress(`phase 2: critique round ${round} (${validPlans.length} critics)`);
				const critResults = await mapPooled(
					validPlans,
					opts.maxConcurrency ?? validPlans.length,
					async ({ angle, plan }) => {
						const result = await runSubagent(CRITIC_PROMPT(plan), "reader");
						const critique = extractJson(result.summary, CritiqueSchema);
						if (critique && !validateCritique(critique).ok) {
							const reason = validateCritique(critique).reason;
							allCritiques.push({ angleId: angle.id, critique: undefined, error: `invalid critique: ${reason}` });
							return { angle, plan, critique: undefined };
						}
						allCritiques.push({
							angleId: angle.id,
							critique,
							error: critique ? undefined : (result.error ?? "critic returned invalid JSON"),
						});
						return { angle, plan, critique };
					},
					opts.signal,
				);

				// judge: independent selection + convergence (only meaningful with >1 candidate)
				let judge: Judge | undefined;
				if (validPlans.length > 1) {
					const entries = critResults
						.filter((c) => c.critique !== undefined)
						.map((c) => ({ angle: c.angle, plan: c.plan, critique: c.critique }));
					const judgeResult = await runSubagent(JUDGE_PROMPT(entries), "judge");
					judge = extractJson(judgeResult.summary, JudgeSchema);
					if (
						judge &&
						!validateJudge(
							judge,
							validPlans.map((p) => p.angle.id),
						).ok
					) {
						judge = undefined; // flaky judge: fall through to frontier-driven termination
					}
				}

				// prune: rejected/fatal → weaknesses reflow; judge gaps → reflow; keep → keptPlans
				let kept = 0;
				let rejected = 0;
				let reflowed = 0;
				const newFrontier: Angle[] = [];
				const scores = new Map((judge?.scores ?? []).map((s) => [s.id, s.score]));
				for (const { angle, plan, critique } of critResults) {
					if (critique && (critique.verdict === "reject" || critique.fatal)) {
						rejected += 1;
						for (const w of critique.weaknesses) {
							if (!exploredHypotheses.has(w)) {
								exploredHypotheses.add(w);
								newFrontier.push({
									id: `refine-${round}-${newFrontier.length + 1}`,
									hypothesis: w,
									approach: w,
									sub_questions: [w],
									evidence_needs: [],
								});
								reflowed += 1;
							}
						}
					} else {
						kept += 1;
						keptPlans.push({ angle, plan, critique, score: scores.get(angle.id) });
					}
				}
				if (judge && !judge.converged) {
					for (const g of judge.gaps) {
						if (!exploredHypotheses.has(g)) {
							exploredHypotheses.add(g);
							newFrontier.push({
								id: `gap-${round}-${newFrontier.length + 1}`,
								hypothesis: g,
								approach: g,
								sub_questions: [g],
								evidence_needs: [],
							});
							reflowed += 1;
						}
					}
				}

				frontier = newFrontier;
				judgeConverged = judge?.converged ?? false;
				trace.push({
					round,
					diverged: planResults.length,
					critiqued: validPlans.length,
					kept,
					rejected,
					reflowed,
					converged: judgeConverged,
				});
			}

			progress(`phase 3: synthesize (${keptPlans.length} kept plans)`);
			if (keptPlans.length === 0) {
				return {
					runId,
					angles: initial,
					factors,
					plans: allPlans,
					critiques: allCritiques,
					error: "no surviving plans to synthesize",
					trace,
					overhead: { subagentCalls: calls },
				};
			}
			const source =
				opts.keep !== undefined
					? [...keptPlans].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, Math.max(1, opts.keep))
					: keptPlans;
			const keptCritiques = allCritiques.filter(
				(c): c is { angleId: string; critique: Critique } =>
					c.critique !== undefined && source.some((p) => p.angle.id === c.angleId),
			);
			const candidateCount = opts.keep !== undefined ? Math.max(1, Math.min(opts.keep, source.length)) : 1;

			const candidates = await mapPooled(
				Array.from({ length: candidateCount }, (_, i) => i),
				opts.maxConcurrency ?? candidateCount,
				async () => {
					const result = await runSubagent(SYNTHESIZER_PROMPT(source, keptCritiques), "reader");
					return extractJson(result.summary, FinalPlanSchema);
				},
				opts.signal,
			);
			// parse-failed candidates drop out; parse-passing ones are never silently discarded —
			// validateFinalPlan only PREFERS self-consistent candidates in the multi-candidate pick.
			const parsedCandidates = candidates.filter((c): c is FinalPlan => c !== undefined);
			const consistent = parsedCandidates.filter((c) => validateFinalPlan(c).ok);

			let finalPlan: FinalPlan | undefined;
			if (parsedCandidates.length === 1) {
				finalPlan = parsedCandidates[0];
			} else if (parsedCandidates.length > 1) {
				const pool = consistent.length > 0 ? consistent : parsedCandidates;
				const pickResult = await runSubagent(FINAL_PICK_PROMPT(pool), "judge");
				const pick = extractJson(pickResult.summary, FinalPickSchema);
				const index = pick && pick.winner_index < pool.length ? pick.winner_index : 0;
				finalPlan = pool[index];
			}

			const nudge = finalPlan ? assertFinalPlanComplete(finalPlan) : undefined;
			return {
				runId,
				angles: initial,
				factors,
				plans: allPlans,
				critiques: allCritiques,
				finalPlan,
				nudge,
				trace,
				overhead: { subagentCalls: calls },
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				runId,
				angles: initial,
				factors,
				plans: allPlans,
				critiques: allCritiques,
				error: message,
				trace,
				overhead: { subagentCalls: calls },
			};
		}
	}
}
