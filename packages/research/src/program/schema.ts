import { z } from "zod";

// Research-program domain model: a dependency DAG of machine-checkable nodes plus an append-only
// journal. Design rules: the zod schema is the single source of truth (TS types inferred); ALL new
// fields must default so files written by older versions still parse (strip mode drops unknowns);
// pure domain — no IO here (persistence in store.ts, execution in verify.ts).

export const CriterionSchema = z.discriminatedUnion("check", [
	z.object({
		check: z.literal("file_exists"),
		description: z.string(),
		path: z.string(),
	}),
	z.object({
		check: z.literal("command"),
		description: z.string(),
		command: z.string(),
		expect_exit: z.number().int().default(0),
		expect_stdout_contains: z.string().optional(),
	}),
	z.object({
		check: z.literal("metric_file"),
		description: z.string(),
		path: z.string(),
		metric: z.string(),
		direction: z.enum(["at_least", "at_most"]),
		threshold: z.number(),
	}),
]);
export type Criterion = z.infer<typeof CriterionSchema>;

// Work-unit kind: drives prompt framing only — scheduling depends on dependencies + acceptance,
// never on the kind.
export const NodeKindSchema = z.enum([
	"theorem",
	"lemma",
	"definition",
	"computation",
	"calibration",
	"experiment",
	"analysis",
	"artifact",
	/**
	 * Implication edge: `implies` names a premise node; the statement is "premise ⟹ conclusion". Proving
	 * it is real progress even if the premise never falls; `bridge` marks cross-domain translation edges.
	 */
	"implication",
]);
export type NodeKind = z.infer<typeof NodeKindSchema>;

// parked = not attackable by the CURRENT generation: dependencies stay live (unlike refuted), and a
// successful calibration unparks automatically.
export const NodeStatusSchema = z.enum(["pending", "active", "proved", "refuted", "parked"]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

// command = exit-code/stdout contract; metric = `METRIC name=value` stdout contract. Lean checks are
// command acceptance — no proof-assistant policy is baked into the domain.
export const AcceptanceSchema = z.discriminatedUnion("check", [
	z.object({
		check: z.literal("command"),
		description: z.string().min(1),
		command: z.string().min(1),
		expect_exit: z.number().int().default(0),
		expect_stdout_contains: z.string().optional(),
	}),
	z.object({
		check: z.literal("metric"),
		description: z.string().min(1),
		command: z.string().min(1),
		metric: z.string().min(1),
		direction: z.enum(["at_least", "at_most"]),
		threshold: z.number(),
	}),
]);
export type Acceptance = z.infer<typeof AcceptanceSchema>;

export const ProgramNodeSchema = z.object({
	id: z.string().min(1),
	kind: NodeKindSchema,
	title: z.string().min(1),
	statement: z.string().min(1),
	/** Documentation only — not machine-checked. */
	leanStatement: z.string().optional(),
	dependsOn: z.array(z.string()).default([]),
	/**
	 * Declared attack instrument: the scheduler pairs it when set (and calibrated); otherwise the latest
	 * calibrated generation is used, with the pairing-mismatch breaker as backstop.
	 */
	instrumentId: z.string().optional(),
	acceptance: AcceptanceSchema,
	status: NodeStatusSchema.default("pending"),
	evidence: z.string().optional(),
	/** Implication edges only: the premise node id; the acceptance must machine-verify premise.statement ⟹ this.statement. */
	implies: z.string().optional(),
	/** Translation edges only: the external domain the premise lives in. */
	domain: z.string().optional(),
	bridge: z.boolean().optional(),
	/** Imported theory: restates a published external result; the acceptance must REPRODUCE it — machine-verified, not a citation. */
	imported: z
		.object({
			source: z.string().min(1),
			reference: z.string().min(1),
		})
		.optional(),
	parkedReason: z.string().optional(),
});
export type ProgramNode = z.infer<typeof ProgramNodeSchema>;

// Append-only op ledger with a CLOSED kind vocabulary: load-bearing membership is decided by ledger.ts
// over exactly these kinds (note/calibration/node_started are context, never progress). Unknown kinds FAIL
// parse — the enum is fail-closed, a newer-version ledger is rejected rather than silently trimmed.
// program_exhausted is legacy-only — no production path writes it (the engine escalates forever; the
// only machine terminal is complete).
export const JournalKindSchema = z.enum([
	"node_started",
	"node_proved",
	"node_refuted",
	"node_parked",
	"node_restated",
	"nodes_added",
	"instrument_calibrated",
	"barrier_recorded",
	"program_completed",
	"program_exhausted",
	"note",
	"calibration",
]);
export type JournalKind = z.infer<typeof JournalKindSchema>;

export const JournalEntrySchema = z.object({
	round: z.number().int().positive(),
	kind: JournalKindSchema,
	nodeId: z.string().optional(),
	/** Instrument attribution for instrument_calibrated/barrier_recorded entries (older journals lack it). */
	instrumentId: z.string().optional(),
	description: z.string().min(1),
	evidence: z.string().min(1),
	at: z.number(),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

// An Instrument is a new tool whose calibration is machine-verified: every `recovers` check passes
// (specialized, it derives a NAMED existing theorem — abstract re-encapsulation does not count) AND
// the `novelty` check passes.
export const RecoverySchema = z.object({
	theorem: z.string().min(1),
	check: AcceptanceSchema,
});
export type Recovery = z.infer<typeof RecoverySchema>;

export const NoveltySchema = z.object({
	statement: z.string().min(1),
	check: AcceptanceSchema,
});
export type Novelty = z.infer<typeof NoveltySchema>;

export const InstrumentStatusSchema = z.enum(["draft", "calibrated", "superseded"]);
export type InstrumentStatus = z.infer<typeof InstrumentStatusSchema>;

export const InstrumentSchema = z.object({
	id: z.string().min(1),
	version: z.number().int().positive(),
	artifacts: z.array(z.string()).default([]),
	recovers: z.array(RecoverySchema).min(1),
	novelty: NoveltySchema,
	status: InstrumentStatusSchema.default("draft"),
	evidence: z.string().optional(),
});
export type Instrument = z.infer<typeof InstrumentSchema>;

// The precise, ideally machine-checked reason a generation cannot reach the target; the next
// instrument must transcend the latest barrier, not route around it.
export const BarrierSchema = z.object({
	instrumentId: z.string().min(1),
	statement: z.string().min(1),
	check: AcceptanceSchema.optional(),
	round: z.number().int().positive(),
});
export type Barrier = z.infer<typeof BarrierSchema>;

export const ProgramSchema = z.object({
	objective: z.string().min(1),
	criteria: z.array(CriterionSchema).min(1),
	nodes: z.array(ProgramNodeSchema),
	journal: z.array(JournalEntrySchema).default([]),
	instruments: z.array(InstrumentSchema).default([]),
	barriers: z.array(BarrierSchema).default([]),
	/** LEGACY-ONLY: ledgers settled "exhausted" by older builds still parse; no production path sets it (the engine escalates forever). */
	status: z.enum(["active", "complete", "blocked", "exhausted"]).default("active"),
	/** Discipline pack id persisted at formalization; continuation re-reads it so a metric program never degrades to math wording. */
	discipline: z.string().optional(),
	/** Optional (older ledgers predate it); consumers fall back to journal[0]?.at ?? updatedAt. */
	startedAt: z.number().optional(),
	updatedAt: z.number().default(() => Date.now()),
});
export type Program = z.infer<typeof ProgramSchema>;
