import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { asTool, type MemoryStore, type SubagentRunner } from "@kea/core";
import { z } from "zod";
import { verifyClaim } from "./acceptance.ts";
import { initAutoresearchController, stepAutoresearchController } from "./autoresearch/controller.ts";
import { compareRuns, freezeContract, loadContract, runEvaluation, varianceGateSatisfied } from "./evaluator.ts";
import type { Journal } from "./journal.ts";
import {
	attacksClosed,
	BlockedReasonSchema,
	checkMobaiIn,
	FrontierPathSchema,
	loadMobaiIn,
	MobaiSchema,
	saveMobaiIn,
} from "./mobai.ts";
import { classifyNovelty, type MaterialRecord, MaterialRecordSchema } from "./novelty.ts";
import { runFidelityJudge } from "./program/judge.ts";
import { loadProgramStrict } from "./program/store.ts";
import { ScienceOrchestrator } from "./science/orchestrator.ts";
import type { FinalPlan } from "./science/schemas.ts";

export interface ResearchToolsContext {
	cwd: string;
	env: ExecutionEnv;
	models: Models;
	/** Current model (getter, follows kernel /model switches; not snapshotted at startup) */
	getModel: () => Model<Api>;
	journal: Journal;
	memory: MemoryStore;

	fetchMaterialRecords?: (query: string) => Promise<unknown[]>;

	/** Permission gate for the check_goal command criterion (default = never execute, fail-closed) */
	reviewMobaiCommand?: (command: string) => "approve" | "deny" | "ask";

	/** Permission gate for evaluate_solution's frozen eval_cmd (same policy chain as mobai command; default = ask, fail-closed) */
	reviewEvalCommand?: (command: string) => "approve" | "deny" | "ask";

	/** subagent runner for science_plan (deferred getter, bound after kernel creation; absent = tool throws) */
	subagents?: () => SubagentRunner | undefined;

	submitSciencePlan?: (plan: string) => Promise<string>;

	// Mobai storage directory, resolved lazily. Defaults to `<cwd>/.kea` (headless continue-mode contract);
	// the TUI passes a session-scoped directory so /exit /new do not inherit the previous session's mobai.
	mobaiDir?: () => string;
}

function mobaiDirOf(ctx: ResearchToolsContext): string {
	return ctx.mobaiDir?.() ?? join(ctx.cwd, ".kea");
}

/** An unsettled session program in the shared mobai dir scopes the legacy tools out: programs are the
 *  recommended path (their criteria are machine-checked by the program loop); a settled program
 *  (complete/exhausted) frees the legacy track again. */
async function activeProgramIn(ctx: ResearchToolsContext) {
	// strict load: a corrupt program.json throws naming the file — treating it as "no program"
	// would let the legacy guards pass and open a zombie second track
	const program = await loadProgramStrict(mobaiDirOf(ctx));
	return program && (program.status === "active" || program.status === "blocked") ? program : undefined;
}

export function createResearchTools(ctx: ResearchToolsContext): AgentTool[] {
	return [
		defineEvaluatorTool(ctx),
		autoresearchInitTool(ctx),
		autoresearchStepTool(ctx),
		evaluateSolutionTool(ctx),
		checkNoveltyTool(ctx),
		verifyClaimTool(ctx),
		startMobaiTool(ctx),
		updateMobaiTool(ctx),
		logProgressTool(ctx),
		rememberTool(ctx),
		noteTool(ctx),
		recallTool(ctx),
		checkMobaiTool(ctx),
		logGapTool(ctx),
		listGapsTool(ctx),
		journalNoteTool(ctx),
		journalRecallTool(ctx),
		sciencePlanTool(ctx),
		submitSciencePlanTool(ctx),
	];
}

function defineEvaluatorTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({
		name: z.string(),
		eval_cmd: z.string().meta({ description: "Command printing `METRIC <name>=<value>` to stdout" }),
		metric_name: z
			.string()
			.meta({ description: "METRIC identifier printed by eval_cmd (must match [A-Za-z_][A-Za-z0-9_]*)" }),
		direction: z.enum(["minimize", "maximize"]),
		seeds: z
			.array(z.number())
			.optional()
			.meta({ description: "At least 2 integer seeds (single-seed runs cannot estimate variance)" }),
		timeout_s: z.number().optional(),
	});
	return asTool({
		name: "define_evaluator",
		label: "Define evaluator",
		description: [
			"Freeze the scoring contract for a research question: a command that prints `METRIC <name>=<value>` to stdout, run once per seed (KEA_SEED).",
			"The contract is frozen and versioned; ANY change starts a new version and scores are NEVER comparable across versions. NEVER rewrite the contract to make a candidate pass — define a new evaluator instead.",
			"Define once per research question, before measuring candidates.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			// TypeBox has no String pattern, so the METRIC identifier contract is enforced here (fail before freeze)
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(params.metric_name)) {
				throw new Error(
					`metric_name "${params.metric_name}" must match [A-Za-z_][A-Za-z0-9_]* (the METRIC identifier printed by eval_cmd)`,
				);
			}
			if (params.seeds !== undefined && params.seeds.length < 2) {
				throw new Error("define_evaluator requires at least 2 seeds (single-seed runs cannot estimate variance)");
			}
			const frozen = await freezeContract(ctx.cwd, {
				name: params.name,
				eval_cmd: params.eval_cmd,
				metric: { name: params.metric_name, direction: params.direction },
				seeds: params.seeds,
				timeout_s: params.timeout_s,
			});
			ctx.journal.append({
				type: "evaluator_frozen",
				refId: frozen.contract.name,
				payload: { version: frozen.version, contentHash: frozen.contentHash },
			});
			return {
				content: [
					{
						type: "text",
						text: `Frozen evaluator "${frozen.contract.name}" v${frozen.version} (hash ${frozen.contentHash}). Metric: ${frozen.contract.metric.name} (${frozen.contract.metric.direction}), seeds=${frozen.contract.seeds.join(",")}.`,
					},
				],
				details: { name: frozen.contract.name, version: frozen.version },
			};
		},
	});
}

function evaluateSolutionTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({
		evaluator: z.string(),
		baseline: z.array(z.number()).optional().meta({
			description:
				"Self-reported baseline metric values (fallback only). Prefer baseline_run: values self-reported by the agent are NOT machine-pinned.",
		}),
		baseline_run: z.string().optional().meta({
			description:
				"run_id of a previously recorded run of the SAME evaluator version (machine-pinned baseline for the noise gate).",
		}),
	});
	return asTool({
		name: "evaluate_solution",
		label: "Evaluate solution",
		description: [
			"Run the frozen evaluator across seeds and report the variance/noise gates.",
			"A single seed is a hypothesis ONLY, and an improvement within pooled noise is NOT progress. Pass baseline_run (a recorded run of the SAME evaluator version) for a machine-pinned baseline; self-reported baseline values are a fallback and are labeled as NOT machine-pinned.",
			"Use for one-off measurements. Inside an autoresearch campaign use autoresearch_step instead — it runs the evaluator and compares against the ledger's best.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			// evaluator name allowlist: loadContract joins .kea/evaluators/<name>.json, rejecting path traversal
			if (!/^[a-z0-9][a-z0-9_-]*$/.test(params.evaluator)) {
				throw new Error(`Invalid evaluator name "${params.evaluator}" (must match [a-z0-9][a-z0-9_-]*).`);
			}
			const frozen = await loadContract(ctx.cwd, params.evaluator);
			if (!frozen) throw new Error(`No frozen evaluator "${params.evaluator}".`);
			// eval_cmd passes the policy gate before execution: under manual/plan any non-approval is denied (same source as the mobai command criterion, avoiding a bash-approval bypass)
			// defaults back to reviewMobaiCommand (same policy chain); fail-closed to ask when both are absent
			const gate = ctx.reviewEvalCommand ?? ctx.reviewMobaiCommand;
			const verdict = gate ? gate(frozen.contract.eval_cmd) : "ask";
			if (verdict !== "approve") {
				throw new Error(
					`evaluator command not approved by policy (${verdict}) — switch permission mode or re-freeze with an approved command`,
				);
			}
			const report = await runEvaluation(ctx.cwd, ctx.env, frozen);
			const runId = randomUUID();
			const lines = [
				`evaluator=${report.evaluator} v${report.version} ok=${report.ok} run_id=${runId}`,
				`valid seeds: ${report.validValues.length}/${report.runs.length}`,
				report.mean !== undefined && report.std !== undefined
					? `mean=${report.mean.toFixed(6)} std=${report.std.toFixed(6)}`
					: "",
				varianceGateSatisfied(report)
					? "variance gate: PASS (≥2 seeds)"
					: "variance gate: FAIL — single-run improvement is a hypothesis only",
			].filter(Boolean);
			if (report.validValues.length >= 2) {
				let baselineValues: number[] | undefined;
				let baselineSource: string | undefined;
				if (params.baseline_run) {
					// lookup not list: not subject to the "most recent 100" recency cap, so old baselines remain searchable
					const recorded = ctx.journal
						.lookup({ type: "run_recorded", refId: report.evaluator })
						.find((e) => (e.payload as { runId?: string }).runId === params.baseline_run);
					if (!recorded) {
						lines.push(`noise gate: no recorded run "${params.baseline_run}" for evaluator "${report.evaluator}"`);
					} else {
						const p = recorded.payload as { version?: number; contentHash?: string; values?: number[] };
						if (p.version !== frozen.version || p.contentHash !== frozen.contentHash) {
							lines.push(
								`noise gate: recorded run "${params.baseline_run}" is from evaluator v${p.version} (${p.contentHash}) — current is v${frozen.version} (${frozen.contentHash}); scores across versions are incomparable, gate skipped`,
							);
						} else if (!Array.isArray(p.values) || p.values.length < 2) {
							lines.push(`noise gate: recorded run "${params.baseline_run}" lacks per-seed values; gate skipped`);
						} else {
							baselineValues = p.values;
							baselineSource = `recorded run ${params.baseline_run} (machine-pinned)`;
						}
					}
				}
				if (!baselineValues && params.baseline && params.baseline.length >= 2) {
					baselineValues = params.baseline;
					baselineSource = "self-reported baseline (NOT machine-pinned)";
				}
				if (baselineValues && baselineSource) {
					const noiseGate = compareRuns(baselineValues, report.validValues, frozen.contract.metric.direction);
					lines.push(
						`noise gate vs ${baselineSource}: ${noiseGate.verdict} (delta=${noiseGate.delta.toFixed(6)}, pooledStd=${noiseGate.pooledStd.toFixed(6)})`,
					);
				}
			} else {
				lines.push("noise gate: inconclusive (needs ≥2 valid seeds)");
			}
			for (const run of report.runs.filter((r) => !r.ok)) {
				lines.push(`seed ${run.seed} failed: ${run.stderr.slice(0, 200)}`);
			}
			ctx.journal.append({
				type: "run_recorded",
				refId: report.evaluator,
				payload: {
					runId,
					version: frozen.version,
					contentHash: frozen.contentHash,
					mean: report.mean,
					std: report.std,
					validSeeds: report.validValues.length,
					seeds: report.runs.filter((r) => r.ok).map((r) => r.seed),
					values: report.validValues,
				},
			});
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				// ok semantics align with the variance gate: a single seed is only a hypothesis, not a "pass"
				details: { ok: report.ok && varianceGateSatisfied(report), mean: report.mean, runId },
			};
		},
	});
}

function checkNoveltyTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({
		query: z.string().meta({ description: "Chemical formula (element composition) to look up, e.g. Bi2Te3" }),
		property: z.string().optional(),
		value: z.number().optional(),
	});
	return asTool({
		name: "check_novelty",
		label: "Check novelty",
		description: [
			"Classify a material against known records: known / refines / contradicts / novel_candidate / unverified.",
			"Contract: an unreachable or failing source returns unverified — unverified is NEVER novel. novel_candidate is NOT verified; it still requires the post-gate (structureMatched + independentCalculation) before promotion.",
			"Call this before ANY novelty claim; do not assert novelty from your own reasoning alone.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			let records: unknown[] = [];
			// An unconfigured source is indistinguishable from an unreachable one: fail closed to unverified.
			let sourceFailed = ctx.fetchMaterialRecords === undefined;
			if (ctx.fetchMaterialRecords) {
				try {
					records = await ctx.fetchMaterialRecords(params.query);
				} catch {
					sourceFailed = true;
				}
			}
			// A source returning dirty records = source problem: fail-closed to unverified too (never blow up the tool over a parse error)
			let parsed: MaterialRecord[] = [];
			try {
				parsed = records.map((r) => MaterialRecordSchema.parse(r));
			} catch {
				sourceFailed = true;
				parsed = [];
			}
			const verdict = classifyNovelty(parsed, { property: params.property, value: params.value }, { sourceFailed });
			ctx.journal.append({
				type: "novelty_checked",
				refId: params.query,
				payload: { classification: verdict.classification },
			});
			const gateNote =
				verdict.classification === "novel_candidate"
					? "\nPost-gate required before verified: structureMatched + independentCalculation (canPromoteToVerified)."
					: "";
			return {
				content: [{ type: "text", text: `${verdict.classification}: ${verdict.rationale}${gateNote}` }],
				details: { classification: verdict.classification },
			};
		},
	});
}

function verifyClaimTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({
		claim: z.string(),
		evidence: z.string(),
	});
	return asTool({
		name: "verify_claim",
		label: "Verify claim",
		description: [
			"Adversarially review a claim against its evidence; fail-closed to REFUTED (an unreachable verifier also returns REFUTED).",
			"Give real numbers, citations with resolvable DOIs, and artifacts as evidence — a summary is not evidence. A REFUTED verdict must be addressed before the claim stands.",
			"Use before reporting any result as established.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			const verdict = await verifyClaim({
				claim: params.claim,
				evidence: params.evidence,
				models: ctx.models,
				model: ctx.getModel(),
			});
			ctx.journal.append({
				type: "claim_verified",
				refId: undefined,
				payload: { claim: params.claim, refuted: verdict.refuted },
			});
			const lines = [verdict.refuted ? "REFUTED" : "UPHELD", ...verdict.reasons.map((r) => `- ${r}`)];
			if (verdict.requiredFixes.length > 0) lines.push("FIX:", ...verdict.requiredFixes.map((f) => `- ${f}`));
			return { content: [{ type: "text", text: lines.join("\n") }], details: { refuted: verdict.refuted } };
		},
	});
}

function startMobaiTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({
		objective: z.string(),
		criteria: z
			.array(
				z.strictObject({
					description: z.string(),
					check: z.enum(["file_exists", "command", "metric_file"]),
					path: z.string().optional(),
					command: z.string().optional(),
					expect_exit: z.number().optional(),
					expect_stdout_contains: z.string().optional(),
					metric: z.string().optional(),
					direction: z.enum(["at_least", "at_most"]).optional(),
					threshold: z.number().optional(),
				}),
			)
			.min(1),
		frontier: z
			.array(
				z.strictObject({
					id: z.string(),
					kind: z.enum(["obstruction", "translation", "instrument", "attack", "calibration"]).optional(),
					description: z.string(),
					falsification_criterion: z.string(),
					recovery: z.string().optional(),
				}),
			)
			.optional(),
	});
	return asTool({
		name: "start_goal",
		label: "Start mobai",
		description: [
			"Define a machine-verifiable objective: completion criteria plus a frontier of falsifiable attack paths.",
			"Contract: criteria are immutable once set, 'complete' is set ONLY by check_goal, and an independent fresh-context reviewer verifies the formalization keeps the objective at full strength before the ledger is written. Decompose an impossible-in-one-step objective into attack paths, each with a falsification_criterion.",
			"Do NOT start a second objective while one is active — continue it with log_progress / update_goal instead.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			if (await activeProgramIn(ctx)) {
				throw new Error(
					"a session program is active — programs are the recommended path; continue it via update_node/add_nodes/program_note, or finish/abandon it (/mobai clear) before starting a legacy objective.",
				);
			}
			// Formalization-fidelity judge (semantic, language-independent): a fresh-context reviewer
			// verifies the criteria keep the objective at full strength before the ledger is written.
			// Absent or failed judge = fail-open (immutability + fail-closed check_goal remain defenses).
			const judgeRunner = ctx.subagents?.();
			if (judgeRunner) {
				const verdict = await runFidelityJudge(judgeRunner, {
					objective: params.objective,
					roots: [],
					criteria: params.criteria.map((c) => c.description),
				});
				if (verdict?.faithful === false) {
					throw new Error(
						`the criteria shrink the objective (${verdict.shrinkment ?? "unfaithful formalization"}). State the full target; scope limits are decided by the user, not written into the completion gate.`,
					);
				}
			}
			// while an unfinished objective ledger exists, start_goal must not silently rewrite it — a re-formalization is a shrink vector
			const existing = await loadMobaiIn(mobaiDirOf(ctx));
			if (existing && existing.status !== "complete") {
				throw new Error(
					"an active objective already exists in this workspace; its criteria are immutable. Continue with log_progress / update_goal, or finish it first.",
				);
			}
			const mobai = MobaiSchema.parse({
				objective: params.objective,
				criteria: params.criteria.map((c) => {
					if (c.check === "file_exists") return { check: c.check, description: c.description, path: c.path };
					if (c.check === "command") {
						return {
							check: c.check,
							description: c.description,
							command: c.command,
							expect_exit: c.expect_exit ?? 0,
							expect_stdout_contains: c.expect_stdout_contains,
						};
					}
					return {
						check: c.check,
						description: c.description,
						path: c.path,
						metric: c.metric,
						direction: c.direction,
						threshold: c.threshold,
					};
				}),
				frontier: (params.frontier ?? []).map((p) => ({
					id: p.id,
					kind: p.kind ?? "attack",
					description: p.description,
					falsification_criterion: p.falsification_criterion,
					recovery: p.recovery,
					status: "open" as const,
				})),
				status: "active",
				// creation-time anchor for the footer clock (updatedAt rewrites every round)
				startedAt: Date.now(),
			});
			await saveMobaiIn(mobaiDirOf(ctx), mobai);
			return {
				content: [
					{
						type: "text",
						text: `Objective set: ${mobai.objective} (${mobai.criteria.length} criteria, ${mobai.frontier.length} frontier paths).`,
					},
				],
				details: {},
			};
		},
	});
}

function updateMobaiTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({
		status: z.enum(["active", "blocked"]),
		blockedReason: z
			.strictObject({
				kind: z.enum(["missing_credential", "external_dependency", "permission", "hardware", "data_unavailable"]),
				detail: z.string(),
			})
			.optional(),
	});
	return asTool({
		name: "update_goal",
		label: "Update mobai",
		description: [
			"Set the objective's status to active or blocked.",
			"'complete' is NOT settable here — ONLY check_goal sets it. blocked requires a concrete external reason (missing credential, external dependency, permission, hardware, data unavailable); NEVER blocked for 'too hard' or 'unproven'. With every attack closed, blocked is REFUSED — a new instrument is needed, and the harness opens one.",
			"For a shrink-not-stop signal use log_progress with newPaths instead.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			if (await activeProgramIn(ctx)) {
				throw new Error(
					"no legacy objective in this session — the active session program is managed via update_node/add_nodes/program_note.",
				);
			}
			const mobai = await loadMobaiIn(mobaiDirOf(ctx));
			if (!mobai) throw new Error("No objective defined.");
			if (params.status === "blocked") {
				if (!params.blockedReason) throw new Error("blocked requires a concrete blockedReason.");
				BlockedReasonSchema.parse(params.blockedReason);
				if (attacksClosed(mobai)) {
					throw new Error(
						"all attacks are closed: this is not blocked, a new instrument is needed. The harness will open one; do not stop.",
					);
				}
			}
			await saveMobaiIn(mobaiDirOf(ctx), {
				...mobai,
				status: params.status,
				blockedReason: params.status === "blocked" ? params.blockedReason : undefined,
				updatedAt: Date.now(),
			});
			return { content: [{ type: "text", text: `Objective status → ${params.status}` }], details: {} };
		},
	});
}

function checkMobaiTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({});
	return asTool({
		name: "check_goal",
		label: "Check mobai",
		description: [
			"Machine-evaluate every objective criterion (file_exists / command exit+stdout / metric_file) and set complete only when ALL pass.",
			"This is the ONLY path that sets 'complete'; a hand-written complete is rolled back to active when criteria have not passed.",
			"Call when you believe the objective is done — not to poll status; read the objective ledger for that.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute() {
			if (await activeProgramIn(ctx)) {
				return {
					content: [
						{
							type: "text",
							text: "A session program is active (program.json) — program criteria are machine-checked by the program loop (every round start and /mobai check). check_goal governs only the legacy workspace mobai.json; there is none in this session.",
						},
					],
					details: {} as { status: "complete" | "active" | "blocked" },
				};
			}
			const { mobai, results } = await checkMobaiIn(ctx.cwd, mobaiDirOf(ctx), ctx.env, ctx.reviewMobaiCommand);
			const lines = results.map((r) => `${r.passed ? "✓" : "✗"} ${r.description} (${r.detail})`);
			lines.push(`objective status: ${mobai.status}`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { status: mobai.status } };
		},
	});
}

function logProgressTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({
		kind: z.enum(["refuted", "artifact", "narrowed", "tool", "replicated", "machine_checked"]),
		description: z.string(),
		evidence: z.string(),
		refutedPathId: z.string().optional(),
		round: z.number().optional(),
		newPaths: z
			.array(
				z.strictObject({
					id: z.string(),
					kind: z.enum(["obstruction", "translation", "instrument", "attack", "calibration"]),
					description: z.string(),
					falsification_criterion: z.string(),
					recovery: z.string().optional(),
				}),
			)
			.optional(),
	});
	return asTool({
		name: "log_progress",
		label: "Log progress",
		description: [
			"Record one machine-checkable progress entry, optionally close a frontier path as refuted (refutedPathId) and add new ledger paths (obstruction / translation / instrument / attack / calibration).",
			"Contract: evidence must name what was checked — narration without a check does NOT count as progress. An instrument path REQUIRES a non-empty recovery (which known result it recovers as a special case).",
			"Use after each real result; use journal_note for notes that are not load-bearing.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			if (await activeProgramIn(ctx)) {
				throw new Error(
					"no legacy objective in this session — the active session program records progress via update_node/add_nodes/program_note.",
				);
			}
			const mobai = await loadMobaiIn(mobaiDirOf(ctx));
			if (!mobai) throw new Error("No objective defined.");
			const round = Math.max(1, Math.round(params.round ?? mobai.progress.length + 1));
			const existingIds = new Set(mobai.frontier.map((p) => p.id));
			for (const p of params.newPaths ?? []) {
				if (existingIds.has(p.id)) throw new Error(`frontier path id already exists: ${p.id}`);
				existingIds.add(p.id);
			}
			const added = (params.newPaths ?? []).map((p) => FrontierPathSchema.parse({ ...p, status: "open" }));
			const frontier = [
				...mobai.frontier.map((p) =>
					p.id === params.refutedPathId ? { ...p, status: "refuted" as const, evidence: params.evidence } : p,
				),
				...added,
			];
			await saveMobaiIn(mobaiDirOf(ctx), {
				...mobai,
				frontier,
				progress: [
					...mobai.progress,
					{ round, kind: params.kind, description: params.description, evidence: params.evidence },
				],
				updatedAt: Date.now(),
			});
			return {
				content: [
					{
						type: "text",
						text: `Progress logged (${params.kind}): ${params.description}${added.length > 0 ? `; added ${added.length} ledger entr${added.length === 1 ? "y" : "ies"} (${added.map((p) => `${p.id}:${p.kind}`).join(", ")})` : ""}`,
					},
				],
				details: {},
			};
		},
	});
}

function logGapTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({
		statement: z.string(),
		track: z.enum(["spr", "method", "synthesis", "exploration", "other"]),
		formalizable: z.boolean(),
		tension: z.string().optional(),
		citations: z.array(z.string()).optional(),
	});
	return asTool({
		name: "log_research_gap",
		label: "Log research gap",
		description: [
			"Record a research gap with its track, tension, and DOI citations.",
			"formalizable=true routes it to the evaluator-driven track (sprp/method/synthesis/exploration).",
			"Check list_research_gaps first — do not log a duplicate gap.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			const id = `gap-${Date.now().toString(36)}`;
			ctx.journal.append({
				type: "gap_opened",
				refId: id,
				payload: {
					statement: params.statement,
					track: params.track,
					formalizable: params.formalizable,
					tension: params.tension,
					evidence: (params.citations ?? []).map((citation) => ({ id: `${id}-e`, citation })),
				},
			});
			return {
				content: [
					{ type: "text", text: `Logged gap ${id} (track=${params.track}, formalizable=${params.formalizable}).` },
				],
				details: { id },
			};
		},
	});
}

function listGapsTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({});
	return asTool({
		name: "list_research_gaps",
		label: "List gaps",
		description: "List open research gaps from the journal (most recent 50). Read this before logging a new gap.",
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute() {
			const events = ctx.journal.list({ type: "gap_opened", limit: 50 });
			if (events.length === 0) return { content: [{ type: "text", text: "No gaps logged." }], details: { count: 0 } };
			const lines = events.map((e) => {
				const p = e.payload as { statement?: string; track?: string; formalizable?: boolean };
				return `- [${e.refId}] (${p.track}${p.formalizable ? ", formalizable" : ""}) ${p.statement}`;
			});
			return { content: [{ type: "text", text: lines.join("\n") }], details: { count: events.length } };
		},
	});
}

function journalNoteTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({ text: z.string() });
	return asTool({
		name: "journal_note",
		label: "Journal note",
		description: [
			"Append a durable note to the research journal.",
			"Negative results MUST be recorded here — a failed attempt with its reason is ledger-worthy.",
			"For load-bearing progress use log_progress; for cross-session memory use remember.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			ctx.journal.append({ type: "note", payload: { text: params.text } });
			return { content: [{ type: "text", text: "Noted." }], details: {} };
		},
	});
}

function journalRecallTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({ query: z.string() });
	return asTool({
		name: "journal_recall",
		label: "Recall",
		description: [
			"Full-text recall over the research journal (FTS5/BM25).",
			"Check BEFORE re-exploring a question — the journal may already hold the answer or a refutation.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			const hits = ctx.journal.recall(params.query);
			if (hits.length === 0) return { content: [{ type: "text", text: "No matches." }], details: { count: 0 } };
			const lines = hits.map((h) => `[${h.type}] ${JSON.stringify(h.payload)}`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { count: hits.length } };
		},
	});
}

function rememberTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({
		text: z.string().meta({ description: "Verified knowledge to persist (fact/decision/lesson)" }),
		kind: z.enum(["fact", "decision", "lesson"]).optional(),
	});
	return asTool({
		name: "remember",
		label: "Remember",
		description: [
			"Persist verified knowledge to long-term memory (injected into future sessions).",
			"ONLY store what you verified; use note for unverified working thoughts.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			ctx.memory.remember(params.text, params.kind ?? "fact");
			return { content: [{ type: "text", text: "Remembered." }], details: {} };
		},
	});
}

function noteTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({ text: z.string() });
	return asTool({
		name: "note",
		label: "Note",
		description: [
			"Append a working note to the session scratchpad (NOT injected into future sessions).",
			"Use remember for verified knowledge worth persisting across sessions.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			ctx.memory.note(params.text);
			return { content: [{ type: "text", text: "Noted." }], details: {} };
		},
	});
}

function recallTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({ query: z.string() });
	return asTool({
		name: "recall",
		label: "Recall",
		description: [
			"Search long-term memory (FTS5/BM25).",
			"Check BEFORE re-exploring a question; for this run's research trail use journal_recall.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			const hits = ctx.memory.recall(params.query);
			if (hits.length === 0) return { content: [{ type: "text", text: "No matches." }], details: { count: 0 } };
			const lines = hits.map((h) => `[${h.source}${h.kind ? `:${h.kind}` : ""}] ${h.text}`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { count: hits.length } };
		},
	});
}

function renderFinalPlan(plan: FinalPlan): string {
	return [
		"# Science plan",
		"",
		"## Objective",
		plan.objective,
		"",
		"## Method",
		plan.method,
		"",
		"## Validation",
		plan.validation,
		"",
		"## Falsification criterion",
		plan.falsification_criterion,
		"",
		"## Risks",
		...plan.risks.map((r) => `- ${r}`),
		"",
		"## Fallback",
		plan.fallback,
		"",
		"## Discarded directions",
		plan.discarded_rationale,
		"",
		"## Next hypotheses",
		...plan.next_hypotheses.map((h) => `- ${h}`),
	].join("\n");
}

function sciencePlanTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({
		problem: z.string().meta({ description: "Scientific problem / competition task to plan" }),
		angles: z
			.array(z.string())
			.optional()
			.meta({ description: "Optional pre-supplied hypotheses (skip the distill phase)" }),
		max_calls: z.number().optional().meta({ description: "Hard cap on total subagent calls across the whole run" }),
		max_concurrency: z.number().optional().meta({ description: "Max parallel subagents per phase" }),
		keep: z.number().optional().meta({ description: "Beam width: keep top-N plans and synthesize N candidates" }),
	});
	return asTool({
		name: "science_plan",
		label: "Science plan",
		description: [
			"Run the science orchestration engine: distill critical factors, diverge over orthogonal hypotheses, adversarially critique, judge, prune, and synthesize ONE falsifiable plan.",
			"A final plan missing a falsification criterion or next hypothesis is flagged, NEVER silently accepted.",
			"Use for open-ended scientific or competition tasks before committing. For a single deterministic plan use plan mode instead.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(
			_id: string,
			params: z.input<typeof parameters>,
			signal?: AbortSignal,
			onUpdate?: (partialResult: unknown) => void,
		) {
			const runner = ctx.subagents?.();
			if (!runner) throw new Error("science_plan requires a subagent runner (not available in this context)");
			const orchestrator = new ScienceOrchestrator(runner);
			const result = await orchestrator.run(params.problem, {
				angles: params.angles,
				maxCalls: params.max_calls,
				maxConcurrency: params.max_concurrency,
				keep: params.keep,
				signal,
				onProgress: (line) => onUpdate?.({ content: [{ type: "text", text: `${line}\n` }], details: { runId: "" } }),
			});
			if (!result.finalPlan) {
				throw new Error(result.error ?? "science_plan produced no final plan");
			}
			const nudgeLine = result.nudge ? `\n\n${result.nudge}` : "";
			return {
				content: [{ type: "text", text: renderFinalPlan(result.finalPlan) + nudgeLine }],
				details: { runId: result.runId, finalPlan: result.finalPlan, nudge: result.nudge },
			};
		},
	});
}

function submitSciencePlanTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({
		plan: z.string().meta({ description: "Final plan markdown produced by science_plan" }),
	});
	return asTool({
		name: "submit_science_plan",
		label: "Submit science plan",
		description: [
			"Submit the final plan produced by science_plan: write it to the plan file and exit science mode for normal review.",
			"Pass the science_plan output verbatim; do not hand-edit a different plan into it.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			if (!ctx.submitSciencePlan) {
				throw new Error("submit_science_plan requires a plan-file callback (not available in this context)");
			}
			const path = await ctx.submitSciencePlan(params.plan);
			return {
				content: [{ type: "text", text: `Science plan submitted for review: ${path}` }],
				details: { path },
			};
		},
	});
}

function autoresearchInitTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({
		evaluator: z.string().meta({ description: "Evaluator name (frozen contract identity)" }),
		eval_cmd: z.string().meta({ description: "Command printing `METRIC <name>=<value>` to stdout" }),
		metric_name: z.string(),
		direction: z.enum(["minimize", "maximize"]),
		seeds: z.array(z.number()).optional(),
		timeout_s: z.number().optional(),
	});
	return asTool({
		name: "autoresearch_init",
		label: "Start autoresearch",
		description: [
			"Freeze an evaluator and run a ≥2-seed baseline to establish the noise floor, then open the autoresearch ledger.",
			"After this, modify the candidate, then call autoresearch_step to honestly measure whether each change beat the best metric beyond noise. The harness NEVER decides your next move.",
			"Call once per campaign — do NOT re-init to reset an inconvenient best.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			const { summary, state } = await initAutoresearchController({
				cwd: ctx.cwd,
				env: ctx.env,
				// eval_cmd passes the policy gate before execution (same source as evaluate_solution, avoiding a bash-approval bypass)
				reviewEvalCommand: ctx.reviewEvalCommand ?? ctx.reviewMobaiCommand,
				evaluator: {
					name: params.evaluator,
					eval_cmd: params.eval_cmd,
					metric: { name: params.metric_name, direction: params.direction },
					seeds: params.seeds,
					timeout_s: params.timeout_s,
				},
			});
			return {
				content: [{ type: "text", text: summary }],
				details: { baselineMean: state.baselineMean },
			};
		},
	});
}

function autoresearchStepTool(ctx: ResearchToolsContext) {
	const parameters = z.strictObject({
		evaluator: z.string().meta({ description: "Evaluator name" }),
		hypothesis: z.string().meta({ description: "What this candidate change is trying to do" }),
		flags: z.array(z.string()).optional().meta({ description: "Integrity flags (reward-hack suspicion)" }),
		ablation: z
			.string()
			.optional()
			.meta({ description: "Attribution: which component moved the needle (informs re-distill)" }),
		falsification: z
			.string()
			.optional()
			.meta({ description: "Falsification note: what would overturn this direction" }),
	});
	return asTool({
		name: "autoresearch_step",
		label: "Measure a candidate",
		description: [
			"Run the frozen evaluator and honestly record whether the current candidate beat the best metric beyond pooled seed noise.",
			"It does NOT decide keep/revert/pivot for you — read the summary and decide yourself.",
			"Use for EVERY candidate measurement inside an autoresearch campaign (not evaluate_solution).",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			const { summary, verdict, kept, state } = await stepAutoresearchController({
				cwd: ctx.cwd,
				env: ctx.env,
				evaluator: params.evaluator,
				hypothesis: params.hypothesis,
				flags: params.flags,
				ablation: params.ablation,
				falsification: params.falsification,
				reviewEvalCommand: ctx.reviewEvalCommand ?? ctx.reviewMobaiCommand,
			});
			return {
				content: [{ type: "text", text: summary }],
				details: { verdict, kept, bestMean: state.bestMean },
			};
		},
	});
}
