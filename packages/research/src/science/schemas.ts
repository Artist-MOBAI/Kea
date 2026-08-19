import { z } from "zod";

export const AngleSchema = z.object({
	id: z.string().min(1),
	hypothesis: z.string().min(1),
	approach: z.string().min(1),
	sub_questions: z.array(z.string()).min(1),
	evidence_needs: z.array(z.string()),
});
export type Angle = z.infer<typeof AngleSchema>;

export const CriticalFactorSchema = z.object({
	id: z.string().min(1),
	factor: z.string().min(1),
	why_critical: z.string().min(1),
	north_star_metric: z.string().min(1),
	current_sota: z.string(),
});
export type CriticalFactor = z.infer<typeof CriticalFactorSchema>;

export const DistillSchema = z.object({
	critical_factors: z.array(CriticalFactorSchema).min(1),
	hypotheses: z.array(AngleSchema).min(1),
});
export type Distill = z.infer<typeof DistillSchema>;

export const PlanSchema = z.object({
	objective: z.string().min(1),
	method: z.string().min(1),
	validation: z.string().min(1),
	falsification_criterion: z.string().min(1),
	risks: z.array(z.string()),
	fallback: z.string(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const CritiqueSchema = z.object({
	verdict: z.enum(["keep", "reject"]),
	fatal: z.boolean(),
	strengths: z.array(z.string()),
	weaknesses: z.array(z.string()),
	novelty: z.enum(["novel", "known", "unverified"]),
	recommendation: z.string(),
});
export type Critique = z.infer<typeof CritiqueSchema>;

export const JudgeScoreSchema = z.object({
	id: z.string().min(1),
	score: z.number(),
	rationale: z.string(),
});
export type JudgeScore = z.infer<typeof JudgeScoreSchema>;

// When converged is false, gaps must be non-empty — enforced by validateJudge, not zod.
export const JudgeSchema = z.object({
	winner_id: z.string().min(1),
	scores: z.array(JudgeScoreSchema).min(1),
	converged: z.boolean(),
	gaps: z.array(z.string()),
});
export type Judge = z.infer<typeof JudgeSchema>;

export const FinalPlanSchema = z.object({
	objective: z.string().min(1),
	method: z.string().min(1),
	validation: z.string().min(1),
	falsification_criterion: z.string().min(1),
	risks: z.array(z.string()),
	fallback: z.string(),
	discarded_rationale: z.string(),
	next_hypotheses: z.array(z.string()).default([]),
});
export type FinalPlan = z.infer<typeof FinalPlanSchema>;

/** Legacy decompose-style output: a list of orthogonal angles. */
export const AnglesListSchema = z.object({
	angles: z.array(AngleSchema).min(1),
});
export type AnglesList = z.infer<typeof AnglesListSchema>;
