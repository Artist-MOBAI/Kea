import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { compareRuns, type EvaluationReport, meanStd } from "../evaluator.ts";

// Autoresearch state: the noise-gated progress ledger for the model-driven SOTA loop. It only
// records, honestly, whether a run moved the best metric beyond pooled seed noise — the decision
// of what to try next stays with the model.

export const AutoresearchRunInputSchema = z.object({
	runId: z.string().min(1),
	hypothesis: z.string().min(1),
	/** per-seed metric values (≥2 recommended so the noise gate can estimate spread) */
	values: z.array(z.number()).min(1),
	/** reward-hack / integrity flags (e.g. "eval tampered", "hardcoded answer"); any flag → never kept */
	flags: z.array(z.string()).default([]),
	/** model's attribution: which component moved the needle (or "no measurable contribution") — informs re-distill/re-design */
	ablation: z.string().optional(),
	/** model's falsification note: does this direction still stand, and what would overturn it */
	falsification: z.string().optional(),
});
export type AutoresearchRunInput = z.input<typeof AutoresearchRunInputSchema>;

export const AutoresearchStateSchema = z.object({
	evaluator: z.string().min(1),
	/** frozen evaluator version this ledger was measured against (scores are never comparable across versions) */
	evaluatorVersion: z.number().int(),
	/** frozen evaluator contentHash (pin the exact scoring contract, not just the name) */
	evaluatorHash: z.string(),
	direction: z.enum(["minimize", "maximize"]),
	baselineValues: z.array(z.number()).min(1),
	baselineMean: z.number(),
	bestValues: z.array(z.number()).min(1),
	bestMean: z.number(),
	bestRunId: z.string().optional(),
	runs: z.array(
		z.object({
			runId: z.string(),
			hypothesis: z.string(),
			mean: z.number(),
			verdict: z.enum(["improvement", "noise", "regression"]),
			kept: z.boolean(),
			flags: z.array(z.string()),
			ablation: z.string().optional(),
			falsification: z.string().optional(),
			timestamp: z.number(),
		}),
	),
});
export type AutoresearchState = z.infer<typeof AutoresearchStateSchema>;

/** Seed the ledger from a baseline evaluation (its per-seed values become the noise floor). */
export function initAutoresearch(args: {
	evaluator: string;
	version: number;
	contentHash: string;
	direction: "minimize" | "maximize";
	baseline: EvaluationReport;
}): AutoresearchState {
	const { mean } = meanStd(args.baseline.validValues);
	return {
		evaluator: args.evaluator,
		evaluatorVersion: args.version,
		evaluatorHash: args.contentHash,
		direction: args.direction,
		baselineValues: [...args.baseline.validValues],
		baselineMean: mean,
		bestValues: [...args.baseline.validValues],
		bestMean: mean,
		runs: [],
	};
}

// Record one run and honestly update the best metric; never decides the model's next move.
export function recordAutoresearchRun(state: AutoresearchState, run: AutoresearchRunInput): AutoresearchState {
	const { mean } = meanStd(run.values);
	const cmp = compareRuns(state.bestValues, run.values, state.direction);
	// flagged runs are suspected reward-hacks: never promoted to best, even if they look better
	const flags = run.flags ?? [];
	const kept = cmp.verdict === "improvement" && flags.length === 0;
	const entry = {
		runId: run.runId,
		hypothesis: run.hypothesis,
		mean,
		verdict: cmp.verdict,
		kept,
		flags,
		ablation: run.ablation,
		falsification: run.falsification,
		timestamp: Date.now(),
	};
	const best = kept
		? { bestValues: [...run.values], bestMean: mean, bestRunId: run.runId }
		: { bestValues: state.bestValues, bestMean: state.bestMean, bestRunId: state.bestRunId };
	return { ...state, ...best, runs: [...state.runs, entry] };
}

export function summarizeAutoresearch(state: AutoresearchState): string {
	const lines = [
		`evaluator=${state.evaluator} direction=${state.direction}`,
		`baseline_mean=${state.baselineMean.toFixed(6)}`,
		`best_mean=${state.bestMean.toFixed(6)}${state.bestRunId ? ` (run ${state.bestRunId})` : ""}`,
		`runs=${state.runs.length}`,
	];
	for (const run of state.runs.slice(-10)) {
		const flags = run.flags.length > 0 ? ` flags=[${run.flags.join(",")}]` : "";
		const ablation = run.ablation ? ` ablation="${run.ablation}"` : "";
		const falsification = run.falsification ? ` falsification="${run.falsification}"` : "";
		lines.push(
			`- ${run.runId} [${run.verdict}${run.kept ? ", kept" : ""}] "${run.hypothesis}" → ${run.mean.toFixed(6)}${flags}${ablation}${falsification}`,
		);
	}
	return lines.join("\n");
}

export function autoresearchDir(cwd: string): string {
	return join(cwd, ".kea", "autoresearch");
}

export async function persistAutoresearch(cwd: string, state: AutoresearchState): Promise<void> {
	const dir = autoresearchDir(cwd);
	await mkdir(dir, { recursive: true });
	const target = join(dir, `${state.evaluator}.json`);
	// Atomic write: never leave a half-written ledger behind (a read-modify-write step is not atomic otherwise).
	const tmp = join(dir, `.${state.evaluator}.json.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	try {
		await Bun.write(tmp, JSON.stringify(state, null, 2));
		await rename(tmp, target);
	} catch (err) {
		await rm(tmp, { force: true }).catch(() => {});
		throw err;
	}
}

export async function loadAutoresearch(cwd: string, evaluator: string): Promise<AutoresearchState | undefined> {
	const file = Bun.file(join(autoresearchDir(cwd), `${evaluator}.json`));
	if (!(await file.exists())) return undefined;
	try {
		return AutoresearchStateSchema.parse(await file.json());
	} catch {
		return undefined;
	}
}
