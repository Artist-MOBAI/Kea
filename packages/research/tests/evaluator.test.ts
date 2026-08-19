import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionEnv } from "@kea/core";
import { afterAll, describe, expect, test } from "vitest";
import {
	compareRuns,
	evaluatorsDir,
	freezeContract,
	loadContract,
	parseMetrics,
	runEvaluation,
	varianceGateSatisfied,
} from "../src/evaluator.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

describe("evaluator contract (M3)", () => {
	test("freeze is idempotent; content change bumps version", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-eval-"));
		const base = {
			name: "bench",
			eval_cmd: "echo 'METRIC score=1'",
			metric: { name: "score", direction: "maximize" as const },
		};

		const first = await freezeContract(workdir, base);
		expect(first.version).toBe(1);
		const same = await freezeContract(workdir, base);
		expect(same.version).toBe(1);

		const changed = await freezeContract(workdir, { ...base, eval_cmd: "echo 'METRIC score=2'" });
		expect(changed.version).toBe(2);

		expect((await loadContract(workdir, "bench"))?.version).toBe(2);
	});

	test("freezeContract releases the mkdir lock when done (lock dir does not linger)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-eval-"));
		await freezeContract(workdir, {
			name: "locked",
			eval_cmd: "echo 'METRIC score=1'",
			metric: { name: "score", direction: "maximize" },
			seeds: [0, 1],
		});
		await expect(stat(join(evaluatorsDir(workdir), ".lock-locked"))).rejects.toThrow();
	});

	test("metric.name must be a METRIC identifier; seeds must be ≥2", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-eval-"));
		await expect(
			freezeContract(workdir, {
				name: "badmetric",
				eval_cmd: "echo 'METRIC score=1'",
				metric: { name: "1 not-an-identifier", direction: "maximize" },
				seeds: [0, 1],
			}),
		).rejects.toThrow(/metric name must match/);

		await expect(
			freezeContract(workdir, {
				name: "badeeds",
				eval_cmd: "echo 'METRIC score=1'",
				metric: { name: "score", direction: "maximize" },
				seeds: [0],
			}),
		).rejects.toThrow();
	});

	test("METRIC protocol parses stdout lines", () => {
		const metrics = parseMetrics("noise\nMETRIC energy_mae=-0.025\nMETRIC wallclock=12.5\nMETRIC bad=x\n");
		expect(metrics.get("energy_mae")).toBe(-0.025);
		expect(metrics.get("wallclock")).toBe(12.5);
		expect(metrics.has("bad")).toBe(false);
	});

	test("non-finite METRIC values count as missing (1e999 → Infinity must not pollute mean/std)", async () => {
		expect(parseMetrics("METRIC x=1e999").has("x")).toBe(false);
		expect(parseMetrics("METRIC x=1e999\nMETRIC y=2").get("y")).toBe(2);

		workdir = await mkdtemp(join(tmpdir(), "kea2-eval-"));
		const frozen = await freezeContract(workdir, {
			name: "overflow",
			eval_cmd: 'echo "METRIC score=1e999"',
			metric: { name: "score", direction: "maximize" },
			seeds: [0, 1],
		});
		const { env } = await createExecutionEnv(workdir);
		const report = await runEvaluation(workdir, env, frozen);
		expect(report.ok).toBe(false);
		expect(report.validValues).toHaveLength(0);
		expect(report.mean === undefined || Number.isFinite(report.mean)).toBe(true);
	}, 20_000);

	test("hash covers seeds/timeout_s: re-freezing with changed seeds or timeout bumps the version", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-eval-"));
		const base = {
			name: "seedhash",
			eval_cmd: "echo 'METRIC score=1'",
			metric: { name: "score", direction: "maximize" as const },
			seeds: [0, 1],
			timeout_s: 60,
		};
		const v1 = await freezeContract(workdir, base);
		expect(v1.version).toBe(1);

		const v2 = await freezeContract(workdir, { ...base, seeds: [7, 8, 9] });
		expect(v2.version).toBe(2);

		const v3 = await freezeContract(workdir, { ...base, seeds: [7, 8, 9], timeout_s: 120 });
		expect(v3.version).toBe(3);

		// Identical input stays idempotent
		const v4 = await freezeContract(workdir, { ...base, seeds: [7, 8, 9], timeout_s: 120 });
		expect(v4.version).toBe(3);
	});

	test("multi-seed evaluation reports mean/std and satisfies the variance gate", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-eval-"));
		const frozen = await freezeContract(workdir, {
			name: "seeded",
			eval_cmd: 'echo "METRIC score=$KEA_SEED"',
			metric: { name: "score", direction: "maximize" },
			seeds: [1, 3],
		});
		const { env } = await createExecutionEnv(workdir);
		const report = await runEvaluation(workdir, env, frozen);
		expect(report.ok).toBe(true);
		expect(report.validValues.sort()).toEqual([1, 3]);
		expect(report.mean).toBe(2);
		expect(varianceGateSatisfied(report)).toBe(true);
	}, 20_000);

	test("tampered frozen contract fails closed on load", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-eval-"));
		await freezeContract(workdir, {
			name: "tampered",
			eval_cmd: "echo 'METRIC score=1'",
			metric: { name: "score", direction: "maximize" },
		});
		const path = join(evaluatorsDir(workdir), "tampered.json");
		const onDisk = JSON.parse(await Bun.file(path).text());
		onDisk.contract.eval_cmd = "echo 'METRIC score=999'"; // edit content, keep the stale hash
		await Bun.write(path, JSON.stringify(onDisk, null, 2));
		await expect(loadContract(workdir, "tampered")).rejects.toThrow(/contentHash mismatch/);
	});

	test("re-freeze archives the previous version", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-eval-"));
		const base = {
			name: "hist",
			eval_cmd: "echo 'METRIC score=1'",
			metric: { name: "score", direction: "maximize" as const },
		};
		const v1 = await freezeContract(workdir, base);
		const v2 = await freezeContract(workdir, { ...base, eval_cmd: "echo 'METRIC score=2'" });
		expect(v2.version).toBe(2);
		const archived = JSON.parse(await Bun.file(join(evaluatorsDir(workdir), "hist.v1.json")).text());
		expect(archived.version).toBe(1);
		expect(archived.contentHash).toBe(v1.contentHash);
		expect(archived.contract.eval_cmd).toBe(base.eval_cmd);
	});

	test("corrupt contract file does not block re-freeze (raw file still archived)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-eval-"));
		const dir = evaluatorsDir(workdir);
		await Bun.write(join(dir, "broken.json"), "{ corrupt, not json");
		const frozen = await freezeContract(workdir, {
			name: "broken",
			eval_cmd: "echo 'METRIC score=1'",
			metric: { name: "score", direction: "maximize" },
		});
		expect(frozen.version).toBe(1);
		expect(await Bun.file(join(dir, "broken.v0.json")).text()).toBe("{ corrupt, not json");
		expect((await loadContract(workdir, "broken"))?.version).toBe(1);
	});

	test("single valid seed fails the variance gate (assumption, not result)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-eval-"));
		const frozen = await freezeContract(workdir, {
			name: "single",
			// seed 0 exits 0 with a METRIC, seed 1 exits non-zero → only one valid value
			eval_cmd: 'echo "METRIC score=1" ; test "$KEA_SEED" -eq 0',
			metric: { name: "score", direction: "maximize" },
			seeds: [0, 1],
		});
		const { env } = await createExecutionEnv(workdir);
		const report = await runEvaluation(workdir, env, frozen);
		expect(report.validValues).toHaveLength(1);
		expect(report.ok).toBe(true);
		expect(varianceGateSatisfied(report)).toBe(false);
	}, 20_000);

	test("eval_cmd exits non-zero → report.ok === false (a METRIC already printed to stdout does not count)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-eval-"));
		const frozen = await freezeContract(workdir, {
			name: "nonzero-exit",
			// Adversarial shape: the metric is already printed to stdout, but the process exits non-zero — ok requires "exit code 0 and a parsed METRIC"
			eval_cmd: 'echo "METRIC score=1" ; exit 7',
			metric: { name: "score", direction: "maximize" },
			seeds: [0, 1],
		});
		const { env } = await createExecutionEnv(workdir);
		const report = await runEvaluation(workdir, env, frozen);
		expect(report.ok).toBe(false);
		expect(report.validValues).toHaveLength(0);
		expect(report.reason).toBeDefined();
		expect(report.runs).toHaveLength(2);
		for (const run of report.runs) expect(run.ok, `seed ${run.seed}`).toBe(false);
	}, 20_000);

	test("eval_cmd crashes (no output + non-zero exit) → report.ok === false, failure recorded per seed", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-eval-"));
		const frozen = await freezeContract(workdir, {
			name: "crash",
			eval_cmd: "exit 3",
			metric: { name: "score", direction: "maximize" },
			seeds: [0, 1],
		});
		const { env } = await createExecutionEnv(workdir);
		const report = await runEvaluation(workdir, env, frozen);
		expect(report.ok).toBe(false);
		expect(report.validValues).toHaveLength(0);
		expect(report.runs[0]?.ok).toBe(false);
	}, 20_000);
});

describe("noise gate / compareRuns (M3, Kea-1 dead-end wiring)", () => {
	test("within pooled-std → noise, not progress", () => {
		const baseline = [0.5, 0.52, 0.49, 0.51];
		const candidate = [0.505, 0.515, 0.5, 0.51];
		expect(compareRuns(baseline, candidate, "maximize").verdict).toBe("noise");
	});

	test("identical runs (delta=0, pooledStd=0) → tie is noise, never regression", () => {
		const tie = compareRuns([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], "maximize");
		expect(tie.delta).toBe(0);
		expect(tie.pooledStd).toBe(0);
		expect(tie.verdict).toBe("noise");
		expect(compareRuns([1, 2, 3], [1, 2, 3], "minimize").verdict).toBe("noise");
	});

	test("clear gain beyond noise → improvement; opposite → regression", () => {
		const baseline = [0.5, 0.51, 0.5, 0.5];
		expect(compareRuns(baseline, [0.9, 0.91, 0.9, 0.9], "maximize").verdict).toBe("improvement");
		expect(compareRuns(baseline, [0.1, 0.11, 0.1, 0.1], "maximize").verdict).toBe("regression");
		expect(compareRuns(baseline, [0.4, 0.41, 0.4, 0.4], "minimize").verdict).toBe("improvement");
	});
});
