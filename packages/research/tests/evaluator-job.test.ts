import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionEnv, type ExecutionBackend, LocalBackend } from "@kea/core";
import { afterAll, describe, expect, test } from "vitest";
import { freezeContract, runEvaluationAsJob, varianceGateSatisfied } from "../src/evaluator.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

// A job that never settles: every status probe fails, so the seed's wait fails while the job is
// still "running" on the backend — the failure path must cancel it before recording the failed run.
class NeverSettlingBackend implements ExecutionBackend {
	readonly name = "never-settling";
	submitted = 0;
	cancelled: string[] = [];

	async submit() {
		this.submitted++;
		return { jobId: `job-${this.submitted}` };
	}
	async status(jobId: string): Promise<never> {
		throw new Error(`backend unreachable (${jobId})`);
	}
	async result(jobId: string): Promise<never> {
		throw new Error(`backend unreachable (${jobId})`);
	}
	async cancel(jobId: string) {
		this.cancelled.push(jobId);
	}
	async reclaimOrphans() {
		return 0;
	}
}

describe("evaluator as jobs (M4, design §3.4)", () => {
	test("each seed runs as an independent job and feeds the variance gate", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-evaljob-"));
		const { env } = await createExecutionEnv(workdir);
		const backend = new LocalBackend(env, workdir);
		const frozen = await freezeContract(workdir, {
			name: "jobbed",
			eval_cmd: 'echo "METRIC score=$KEA_SEED.5"',
			metric: { name: "score", direction: "maximize" },
			seeds: [1, 2],
		});

		const report = await runEvaluationAsJob({ cwd: workdir, backend, frozen });
		expect(report.ok).toBe(true);
		expect(report.validValues.sort()).toEqual([1.5, 2.5]);
		expect(report.mean).toBe(2);
		expect(varianceGateSatisfied(report)).toBe(true);
		await backend.cancelAll();
	}, 30_000);

	test("job failure (no METRIC) → the seed is recorded invalid", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-evaljob-"));
		const { env } = await createExecutionEnv(workdir);
		const backend = new LocalBackend(env, workdir);
		const frozen = await freezeContract(workdir, {
			name: "broken",
			eval_cmd: "echo no-metric-here",
			metric: { name: "score", direction: "maximize" },
			seeds: [0, 1],
		});
		const report = await runEvaluationAsJob({ cwd: workdir, backend, frozen });
		expect(report.ok).toBe(false);
		expect(report.reason).toContain("no seed");
		await backend.cancelAll();
	}, 30_000);

	test("job never settles → failure path best-effort cancels + failed seeds recorded", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-evaljob-"));
		const { env } = await createExecutionEnv(workdir);
		const backend = new NeverSettlingBackend();
		const frozen = await freezeContract(workdir, {
			name: "stuck",
			eval_cmd: "sleep 60",
			metric: { name: "score", direction: "maximize" },
			seeds: [0, 1],
		});
		const report = await runEvaluationAsJob({ cwd: workdir, backend, frozen, pollIntervalMs: 10 });
		expect(backend.cancelled).toEqual(["job-1", "job-2"]); // every abandoned job was cancelled
		expect(report.runs.map((r) => r.ok)).toEqual([false, false]); // failures recorded, not swallowed
		expect(report.ok).toBe(false);
		await env.exec("true", { timeout: 5 }).catch(() => {});
	}, 30_000);
});
