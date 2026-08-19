import { createHash } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { getOrThrow } from "@earendil-works/pi-agent-core";
import type { ExecutionBackend, JobResult } from "@kea/core";
import { isSettled } from "@kea/core";
import { z } from "zod";
import { reasonOf } from "./http.ts";

export const EvaluatorContractSchema = z.object({
	name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "evaluator name: [a-z0-9_-]"),
	eval_cmd: z.string().min(1),
	metric: z.object({
		name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "metric name must match [A-Za-z_][A-Za-z0-9_]*"),
		direction: z.enum(["minimize", "maximize"]),
	}),
	seeds: z.array(z.number().int()).min(2).default([0, 1, 2]),
	timeout_s: z.number().positive().default(600),
	requirements: z.array(z.string()).optional(),
	env_name: z.string().optional(),
});
export type EvaluatorContractInput = z.input<typeof EvaluatorContractSchema>;
export type EvaluatorContract = z.infer<typeof EvaluatorContractSchema>;

export const FrozenContractSchema = z.object({
	contract: EvaluatorContractSchema,
	version: z.number(),
	contentHash: z.string(),
	frozenAt: z.number(),
});
export type FrozenContract = z.infer<typeof FrozenContractSchema>;

export function evaluatorsDir(cwd: string): string {
	return join(cwd, ".kea", "evaluators");
}

export function contractHash(contract: EvaluatorContract): string {
	// Every field that changes evaluation semantics is hashed (seeds, timeout_s included), so re-freezing
	// with different values bumps the version instead of silently reusing the previous contract.
	const canonical = JSON.stringify({
		eval_cmd: contract.eval_cmd,
		metric: contract.metric,
		requirements: contract.requirements ?? [],
		seeds: contract.seeds,
		timeout_s: contract.timeout_s,
		env_name: contract.env_name ?? "",
	});
	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

const DIR_LOCK_TIMEOUT_MS = 30_000;
const DIR_LOCK_RETRY_MS = 25;

// mkdir-based advisory lock: concurrent same-name freezes must not race the exists→read→archive→write
// sequence, or one writer can archive/overwrite another's version history.
async function withDirLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + DIR_LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			await mkdir(lockDir);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (Date.now() >= deadline) throw new Error(`timed out acquiring lock ${lockDir}`);
			await new Promise((resolve) => setTimeout(resolve, DIR_LOCK_RETRY_MS));
		}
	}
	try {
		return await fn();
	} finally {
		await rmdir(lockDir).catch(() => {});
	}
}

export async function freezeContract(cwd: string, input: EvaluatorContractInput): Promise<FrozenContract> {
	const contract = EvaluatorContractSchema.parse(input);
	const dir = evaluatorsDir(cwd);
	await mkdir(dir, { recursive: true });
	const lockDir = join(dir, `.lock-${contract.name}`);
	return withDirLock(lockDir, async () => {
		const path = join(dir, `${contract.name}.json`);
		const hash = contractHash(contract);

		let version = 1;
		const existing = Bun.file(path);
		if (await existing.exists()) {
			const raw = await existing.text();
			let prev: FrozenContract | undefined;
			let prevVersion: number | undefined;
			try {
				const json: unknown = JSON.parse(raw);
				// version probe is independent of overall validity: version history continues even for a corrupt prior contract
				const versionProbe = z.object({ version: z.number() }).safeParse(json);
				if (versionProbe.success) prevVersion = versionProbe.data.version;
				if (prevVersion !== undefined) {
					const parsed = FrozenContractSchema.safeParse(json);
					if (parsed.success) prev = parsed.data;
				}
			} catch {
				// Corrupt prior contract: treat as no prior contract, but keep the raw file in the archive below.
			}
			if (prev && prev.contentHash === hash) return prev;
			if (prevVersion !== undefined) version = prevVersion + 1;
			// Archive the previous contract so version history survives the overwrite (v0 = unrecoverable version).
			await Bun.write(join(dir, `${contract.name}.v${prevVersion ?? 0}.json`), raw);
		}
		const frozen: FrozenContract = { contract, version, contentHash: hash, frozenAt: Date.now() };
		await Bun.write(path, JSON.stringify(frozen, null, 2));
		return frozen;
	});
}

export async function loadContract(cwd: string, name: string): Promise<FrozenContract | undefined> {
	const file = Bun.file(join(evaluatorsDir(cwd), `${name}.json`));
	if (!(await file.exists())) return undefined;
	let json: unknown;
	try {
		json = await file.json();
	} catch {
		return undefined;
	}
	const frozen = FrozenContractSchema.safeParse(json);
	// Fail-closed integrity check: recompute the hash over the same fields freezeContract hashes.
	if (!frozen.success || frozen.data.contentHash !== contractHash(frozen.data.contract)) {
		throw new Error(
			"evaluator contract tampered: contentHash mismatch (re-freeze with define_evaluator to accept the change)",
		);
	}
	return frozen.data;
}

// Single source of truth: harness parsing and the delivery score.py template share this pattern so recomputation never drifts.
export const METRIC_VALUE_PATTERN = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?`;

// Trailing \s*$ anchor rejects trailing garbage/truncated exponents (METRIC x=1.5e, 1.5abc must not parse as 1.5)
const METRIC_LINE = new RegExp(String.raw`^METRIC\s+([A-Za-z_][A-Za-z0-9_]*)=(${METRIC_VALUE_PATTERN})\s*$`);

export function parseMetrics(stdout: string): Map<string, number> {
	const metrics = new Map<string, number>();
	for (const line of stdout.split("\n")) {
		const match = METRIC_LINE.exec(line.trim());
		if (!match) continue;
		const name = match[1] as string;
		const value = Number(match[2] as string);
		// Overflowing literals (e.g. METRIC x=1e999) parse to ±Infinity: treat them as absent so a
		// non-finite value never poisons mean/std; delivery.ts score.py mirrors this rule (never diverge).
		if (Number.isFinite(value)) metrics.set(name, value);
	}
	return metrics;
}

export interface SeedRun {
	seed: number;
	ok: boolean;
	value?: number;
	stdout: string;
	stderr: string;
}

export interface EvaluationReport {
	evaluator: string;
	version: number;
	runs: SeedRun[];
	validValues: number[];
	mean?: number;
	std?: number;
	ok: boolean;
	reason?: string;
}

/** ok is defined as "exit code 0 and the target METRIC parsed", so an ok run always has a finite value. */
function hasValidValue(run: SeedRun): run is SeedRun & { value: number } {
	return run.ok;
}

function recordSeedRun(seed: number, metricName: string, exitCode: number, stdout: string, stderr: string): SeedRun {
	const value = parseMetrics(stdout).get(metricName);
	return {
		seed,
		ok: value !== undefined && exitCode === 0,
		value,
		stdout: tail(stdout, 2000),
		stderr: tail(stderr, 1000),
	};
}

function failedSeedRun(seed: number, err: unknown): SeedRun {
	return { seed, ok: false, stdout: "", stderr: reasonOf(err) };
}

function assembleReport(frozen: FrozenContract, runs: SeedRun[]): EvaluationReport {
	const { contract, version } = frozen;
	const validValues = runs.filter(hasValidValue).map((run) => run.value);
	if (validValues.length === 0) {
		return {
			evaluator: contract.name,
			version,
			runs,
			validValues,
			ok: false,
			reason: "no seed produced a valid METRIC value",
		};
	}
	const { mean, std } = meanStd(validValues);
	return { evaluator: contract.name, version, runs, validValues, mean, std, ok: true };
}

// KEA_SEED is passed only via the env parameter (exec and job submission each inject it into the
// child process environment), never shell-concatenated.
export async function runEvaluation(cwd: string, env: ExecutionEnv, frozen: FrozenContract): Promise<EvaluationReport> {
	const { contract } = frozen;
	const runs: SeedRun[] = [];
	for (const seed of contract.seeds) {
		try {
			const result = getOrThrow(
				await env.exec(contract.eval_cmd, { timeout: contract.timeout_s, env: { KEA_SEED: String(seed) }, cwd }),
			);
			runs.push(recordSeedRun(seed, contract.metric.name, result.exitCode, result.stdout, result.stderr));
		} catch (err) {
			runs.push(failedSeedRun(seed, err));
		}
	}
	return assembleReport(frozen, runs);
}

// cwd is bound by the backend itself (takes effect on submit); args.cwd here is only a convenience field.
export async function runEvaluationAsJob(args: {
	cwd: string;
	backend: ExecutionBackend;
	frozen: FrozenContract;
	pollIntervalMs?: number;
}): Promise<EvaluationReport> {
	const { backend, frozen } = args;
	const pollIntervalMs = args.pollIntervalMs ?? 200;
	const { contract } = frozen;
	const runs: SeedRun[] = [];
	for (const seed of contract.seeds) {
		let jobId: string | undefined;
		try {
			({ jobId } = await backend.submit({
				command: contract.eval_cmd,
				label: `eval ${contract.name} seed=${seed}`,
				timeoutMs: contract.timeout_s * 1000,
				env: { KEA_SEED: String(seed) },
			}));
			const result = await waitJobSettled(backend, jobId, contract.timeout_s * 1000 + 30_000, pollIntervalMs);
			runs.push(recordSeedRun(seed, contract.metric.name, result.exitCode ?? 1, result.stdout, result.stderr));
		} catch (err) {
			// a seed that never settled leaves the job running on the backend: cancel it best-effort so a
			// settled report never abandons a still-burning process
			if (jobId !== undefined) await backend.cancel(jobId).catch(() => {});
			runs.push(failedSeedRun(seed, err));
		}
	}
	return assembleReport(frozen, runs);
}

async function waitJobSettled(
	backend: ExecutionBackend,
	jobId: string,
	timeoutMs: number,
	pollIntervalMs: number,
): Promise<JobResult> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = await backend.status(jobId);
		if (isSettled(status.state)) return backend.result(jobId);
		if (Date.now() > deadline) throw new Error(`eval job ${jobId} did not settle within ${timeoutMs}ms`);
		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}
}

export function varianceGateSatisfied(report: EvaluationReport, minSeeds = 2): boolean {
	return report.validValues.length >= minSeeds;
}

export function meanStd(values: readonly number[]): { mean: number; std: number } {
	if (values.length === 0) {
		// an empty sample has no mean/std: return 0 rather than NaN so callers never pollute bestMean/mean with NaN
		return { mean: 0, std: 0 };
	}
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / Math.max(values.length - 1, 1);
	return { mean, std: Math.sqrt(variance) };
}

export function compareRuns(
	baseline: readonly number[],
	candidate: readonly number[],
	direction: "minimize" | "maximize",
): { verdict: "improvement" | "noise" | "regression"; delta: number; pooledStd: number } {
	if (baseline.length < 2 || candidate.length < 2) {
		// A single value cannot estimate spread: neither direction constitutes evidence, only noise.
		return { verdict: "noise", delta: Number.NaN, pooledStd: Number.NaN };
	}
	const b = meanStd(baseline);
	const c = meanStd(candidate);
	const delta = c.mean - b.mean;
	const pooledStd = Math.sqrt((b.std ** 2 + c.std ** 2) / 2);
	if (delta === 0) {
		// Exact tie: identical deterministic runs (pooledStd often 0) are noise, never a regression.
		return { verdict: "noise", delta, pooledStd };
	}
	const improved = direction === "minimize" ? delta < 0 : delta > 0;
	if (pooledStd > 0 && Math.abs(delta) <= pooledStd) {
		return { verdict: "noise", delta, pooledStd };
	}
	return { verdict: improved ? "improvement" : "regression", delta, pooledStd };
}

function tail(text: string, max: number): string {
	return text.length <= max ? text : `…${text.slice(-max)}`;
}
