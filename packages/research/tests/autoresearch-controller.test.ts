import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionEnv } from "@kea/core";
import { afterAll, describe, expect, test } from "vitest";
import { initAutoresearchController, stepAutoresearchController } from "../src/autoresearch/controller.ts";
import { freezeContract } from "../src/evaluator.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

async function setup(): Promise<{ cwd: string; env: ReturnType<typeof createExecutionEnv>["env"] }> {
	workdir = await mkdtemp(join(tmpdir(), "kea2-autoresearch-"));
	await Bun.write(join(workdir, "metric.sh"), '#!/usr/bin/env bash\necho "METRIC score=$((10 - KEA_SEED))"\n');
	const { env } = await createExecutionEnv(workdir);
	return { cwd: workdir, env };
}

// controller calls are permission-gated (fail-closed to ask); tests exercise the approved path explicitly
const approve: () => "approve" = () => "approve";

describe("autoresearch controller (freeze → baseline → step → noise-gate bookkeeping)", () => {
	test("init builds the baseline noise floor; step keeps a real improvement and updates best", async () => {
		const { cwd, env } = await setup();

		const init = await initAutoresearchController({
			cwd,
			env,
			reviewEvalCommand: approve,
			evaluator: {
				name: "yeast",
				eval_cmd: "bash metric.sh",
				metric: { name: "score", direction: "minimize" },
				seeds: [0, 1, 2],
			},
		});
		expect(init.state.baselineMean).toBeCloseTo(9, 5);
		expect(init.state.bestMean).toBeCloseTo(9, 5);
		expect(init.state.runs).toHaveLength(0);

		// rewrite the script underneath (frozen eval_cmd unchanged) → simulates a candidate improvement
		await Bun.write(join(cwd, "metric.sh"), '#!/usr/bin/env bash\necho "METRIC score=$((3 - KEA_SEED))"\n');
		const step = await stepAutoresearchController({
			cwd,
			env,
			evaluator: "yeast",
			hypothesis: "conditional flow",
			reviewEvalCommand: approve,
		});
		expect(step.verdict).toBe("improvement");
		expect(step.kept).toBe(true);
		expect(step.state.bestMean).toBeCloseTo(2, 5);
		expect(step.state.runs).toHaveLength(1);
		expect(step.summary).toContain("[improvement, kept]");
	});

	test("step throws when there is no init state", async () => {
		const { cwd, env } = await setup();
		await expect(
			stepAutoresearchController({ cwd, env, evaluator: "ghost", hypothesis: "x", reviewEvalCommand: approve }),
		).rejects.toThrow(/no frozen evaluator/);
	});

	test("a flagged run is not kept even if it improves", async () => {
		const { cwd, env } = await setup();
		await initAutoresearchController({
			cwd,
			env,
			reviewEvalCommand: approve,
			evaluator: {
				name: "yeast",
				eval_cmd: "bash metric.sh",
				metric: { name: "score", direction: "minimize" },
				seeds: [0, 1, 2],
			},
		});
		await Bun.write(join(cwd, "metric.sh"), '#!/usr/bin/env bash\necho "METRIC score=$((3 - KEA_SEED))"\n');
		const step = await stepAutoresearchController({
			cwd,
			env,
			evaluator: "yeast",
			hypothesis: "suspicious",
			flags: ["eval tampered"],
			reviewEvalCommand: approve,
		});
		expect(step.verdict).toBe("improvement");
		expect(step.kept).toBe(false);
		expect(step.state.bestRunId).toBeUndefined();
	});

	test("eval yields no valid METRIC (candidate crashed) → step throws instead of recording NaN", async () => {
		const { cwd, env } = await setup();
		await initAutoresearchController({
			cwd,
			env,
			reviewEvalCommand: approve,
			evaluator: {
				name: "yeast",
				eval_cmd: "bash metric.sh",
				metric: { name: "score", direction: "minimize" },
				seeds: [0, 1, 2],
			},
		});
		// overwrite the script: no more METRIC line → runEvaluation validValues is empty
		await Bun.write(join(cwd, "metric.sh"), '#!/usr/bin/env bash\necho "no metric here"\n');
		await expect(
			stepAutoresearchController({ cwd, env, evaluator: "yeast", hypothesis: "crashed", reviewEvalCommand: approve }),
		).rejects.toThrow(/no valid METRIC value/);
	});

	test("ledger pinned to v1 → step rejected against a re-frozen v2 (cross-version scores incomparable)", async () => {
		const { cwd, env } = await setup();
		await initAutoresearchController({
			cwd,
			env,
			reviewEvalCommand: approve,
			evaluator: {
				name: "yeast",
				eval_cmd: "bash metric.sh",
				metric: { name: "score", direction: "minimize" },
				seeds: [0, 1, 2],
			},
		});
		// re-freeze the same name with changed content → v2; the old ledger stays pinned to v1
		await freezeContract(cwd, {
			name: "yeast",
			eval_cmd: "true",
			metric: { name: "score", direction: "minimize" },
			seeds: [0, 1, 2],
		});
		await expect(
			stepAutoresearchController({ cwd, env, evaluator: "yeast", hypothesis: "x", reviewEvalCommand: approve }),
		).rejects.toThrow(/incomparable/);
	});

	test("mkdir lock released after step completes (no lock dir residue)", async () => {
		const { cwd, env } = await setup();
		await initAutoresearchController({
			cwd,
			env,
			reviewEvalCommand: approve,
			evaluator: {
				name: "yeast",
				eval_cmd: "bash metric.sh",
				metric: { name: "score", direction: "minimize" },
				seeds: [0, 1, 2],
			},
		});
		await Bun.write(join(cwd, "metric.sh"), '#!/usr/bin/env bash\necho "METRIC score=$((3 - KEA_SEED))"\n');
		await stepAutoresearchController({
			cwd,
			env,
			evaluator: "yeast",
			hypothesis: "improvement",
			reviewEvalCommand: approve,
		});
		await expect(stat(join(cwd, ".kea", "autoresearch", ".lock-yeast"))).rejects.toThrow();
	});
});
