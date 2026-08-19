import { randomUUID } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { type EvaluatorContractInput, freezeContract, loadContract, runEvaluation } from "../evaluator.ts";
import {
	type AutoresearchState,
	autoresearchDir,
	initAutoresearch,
	loadAutoresearch,
	persistAutoresearch,
	recordAutoresearchRun,
	summarizeAutoresearch,
} from "./state.ts";

// Autoresearch controller: never decides what to try next — it freezes a baseline and honestly
// records whether a run moved the best metric beyond pooled seed noise.

export type EvalCommandGate = (command: string) => "approve" | "deny" | "ask";

/** Enforce the evaluator-command permission gate (same policy chain as evaluate_solution); fail-closed to ask when absent. */
function assertEvalApproved(gate: EvalCommandGate | undefined, command: string): void {
	const verdict = gate ? gate(command) : "ask";
	if (verdict !== "approve") {
		throw new Error(
			`evaluator command not approved by policy (${verdict}) — switch permission mode or re-freeze with an approved command`,
		);
	}
}

/** evaluator name allowlist (same as evaluate_solution): rejects path traversal before loadContract joins the path. */
export function assertEvaluatorName(name: string): void {
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
		throw new Error(`Invalid evaluator name "${name}" (must match [a-z0-9][a-z0-9_-]*).`);
	}
}

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 25;

// mkdir-based advisory lock: mkdir succeeds = acquired, EEXIST = busy-wait with backoff until timeout.
// A crashed holder can strand a lock — that fails closed to a timeout, never an unlocked read-modify-write.
async function withFileLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			await mkdir(lockDir);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (Date.now() >= deadline) throw new Error(`timed out acquiring lock ${lockDir}`);
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
	try {
		return await fn();
	} finally {
		await rmdir(lockDir).catch(() => {});
	}
}

export async function initAutoresearchController(args: {
	cwd: string;
	env: ExecutionEnv;
	evaluator: EvaluatorContractInput;
	/** permission gate for eval_cmd (default = ask, fail-closed); absent in bare controller calls */
	reviewEvalCommand?: EvalCommandGate;
}): Promise<{ state: AutoresearchState; summary: string }> {
	assertEvalApproved(args.reviewEvalCommand, args.evaluator.eval_cmd);
	const frozen = await freezeContract(args.cwd, args.evaluator);
	const baseline = await runEvaluation(args.cwd, args.env, frozen);
	if (!baseline.ok || baseline.validValues.length < 2) {
		throw new Error("autoresearch baseline needs ≥2 valid seeds to establish a noise floor");
	}
	const state = initAutoresearch({
		evaluator: frozen.contract.name,
		version: frozen.version,
		contentHash: frozen.contentHash,
		direction: frozen.contract.metric.direction,
		baseline,
	});
	await persistAutoresearch(args.cwd, state);
	return { state, summary: summarizeAutoresearch(state) };
}

export interface AutoresearchStepResult {
	state: AutoresearchState;
	summary: string;
	verdict: "improvement" | "noise" | "regression";
	kept: boolean;
}

export async function stepAutoresearchController(args: {
	cwd: string;
	env: ExecutionEnv;
	evaluator: string;
	hypothesis: string;
	/** reward-hack / integrity flags (any flag → the run is never kept) */
	flags?: string[];
	/** model's attribution: which component moved the needle (informs re-distill/re-design) */
	ablation?: string;
	/** model's falsification note: does this direction still stand, and what would overturn it */
	falsification?: string;
	/** permission gate for the frozen eval_cmd (default = ask, fail-closed); absent in bare controller calls */
	reviewEvalCommand?: EvalCommandGate;
}): Promise<AutoresearchStepResult> {
	assertEvaluatorName(args.evaluator);
	const frozen = await loadContract(args.cwd, args.evaluator);
	if (!frozen) throw new Error(`no frozen evaluator "${args.evaluator}"`);
	assertEvalApproved(args.reviewEvalCommand, frozen.contract.eval_cmd);

	const lockDir = join(autoresearchDir(args.cwd), `.lock-${args.evaluator}`);
	return withFileLock(lockDir, async () => {
		const prev = await loadAutoresearch(args.cwd, args.evaluator);
		if (!prev) throw new Error(`no autoresearch state for "${args.evaluator}" (run autoresearch_init first)`);
		// a step against a re-frozen evaluator must never be compared to the old ledger's best
		if (prev.evaluatorVersion !== frozen.version || prev.evaluatorHash !== frozen.contentHash) {
			throw new Error(
				`autoresearch state for "${args.evaluator}" is pinned to evaluator v${prev.evaluatorVersion} (${prev.evaluatorHash}) but the frozen contract is v${frozen.version} (${frozen.contentHash}); scores across versions are incomparable — re-run autoresearch_init`,
			);
		}

		const report = await runEvaluation(args.cwd, args.env, frozen);
		if (report.validValues.length === 0) {
			throw new Error("eval produced no valid METRIC value — the candidate likely crashed; fix it and re-run");
		}
		const state = recordAutoresearchRun(prev, {
			runId: randomUUID(),
			hypothesis: args.hypothesis,
			values: report.validValues,
			flags: args.flags,
			ablation: args.ablation,
			falsification: args.falsification,
		});
		await persistAutoresearch(args.cwd, state);

		const last = state.runs[state.runs.length - 1];
		return {
			state,
			summary: summarizeAutoresearch(state),
			verdict: last?.verdict ?? "noise",
			kept: last?.kept ?? false,
		};
	});
}
