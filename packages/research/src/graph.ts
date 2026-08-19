import { z } from "zod";

export const EvidenceSchema = z.object({
	id: z.string(),

	citation: z.string().min(1),
	note: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ResearchGapSchema = z.object({
	id: z.string(),
	statement: z.string().min(1),
	domain: z.string().optional(),
	track: z.enum(["spr", "method", "synthesis", "exploration", "other"]),

	formalizable: z.boolean(),
	suggested_evaluator: z.string().optional(),

	tension: z.string().optional(),
	evidence: z.array(EvidenceSchema).default([]),
	status: z.enum(["open", "addressed", "dropped"]),
	openedAt: z.number(),
	updatedAt: z.number(),
});
export type ResearchGap = z.infer<typeof ResearchGapSchema>;

export const HypothesisCertificateSchema = z.object({
	mechanismModel: z.string().describe("Mechanism model: why this happens"),
	tension: z.string().describe("Point of tension with existing knowledge/observations"),
	falsifiableStatement: z.string().describe("Falsifiable statement"),
	decisiveExperiment: z.string().describe("Minimal decisive experiment"),
	failureUpdateRule: z.string().describe("How belief updates if falsified"),
});
export type HypothesisCertificate = z.infer<typeof HypothesisCertificateSchema>;

export const HypothesisSchema = z.object({
	id: z.string(),
	gapId: z.string().optional(),
	statement: z.string().min(1),
	certificate: HypothesisCertificateSchema,
	belief: z.number().min(0).max(1).default(0.5),
	status: z.enum(["proposed", "under_test", "supported", "refuted", "abandoned"]),
	updatedAt: z.number(),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const ClaimStatusSchema = z.enum(["verified", "correlative", "hypothetical", "refuted"]);

export const ClaimSchema = z.object({
	id: z.string(),
	hypothesisId: z.string().optional(),
	statement: z.string().min(1),
	status: ClaimStatusSchema,

	relation_to_prior: z.enum(["consistent", "refines", "contradicts", "unknown"]).default("unknown"),

	supportingArtifacts: z.array(z.string()).default([]),
	evidence: z.array(EvidenceSchema).default([]),

	falsificationCriterion: z.string().optional(),
	madeAt: z.number(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ExperimentRecordSchema = z.object({
	id: z.string(),
	hypothesisId: z.string().optional(),
	evaluator: z.string().optional(),

	provenance: z.record(z.string(), z.unknown()).default({}),
	metrics: z.record(z.string(), z.number()).default({}),
	outcome: z.enum(["keep", "discard", "crash", "pending"]),
	note: z.string().optional(),
	recordedAt: z.number(),
});
export type ExperimentRecord = z.infer<typeof ExperimentRecordSchema>;
