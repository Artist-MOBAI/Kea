import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	initAutoresearch,
	loadAutoresearch,
	persistAutoresearch,
	recordAutoresearchRun,
	summarizeAutoresearch,
} from "../src/autoresearch/state.ts";
import type { EvaluationReport } from "../src/evaluator.ts";

const baseline = (values: number[]): EvaluationReport => ({
	evaluator: "yeast",
	version: 1,
	runs: [],
	validValues: values,
	mean: undefined,
	std: undefined,
	ok: true,
});

describe("initAutoresearch", () => {
	test("builds the noise floor from the baseline + best = baseline", () => {
		const state = initAutoresearch({
			evaluator: "yeast",
			version: 1,
			contentHash: "abc123",
			direction: "minimize",
			baseline: baseline([0.5, 0.51, 0.52]),
		});
		expect(state.baselineMean).toBeCloseTo(0.51, 5);
		expect(state.bestMean).toBeCloseTo(0.51, 5);
		expect(state.bestRunId).toBeUndefined();
		expect(state.runs).toEqual([]);
		expect(state.evaluatorVersion).toBe(1);
		expect(state.evaluatorHash).toBe("abc123");
	});
});

describe("recordAutoresearchRun (noise gate + flags against reward-hacking)", () => {
	const base = () =>
		initAutoresearch({
			evaluator: "yeast",
			version: 1,
			contentHash: "abc123",
			direction: "minimize",
			baseline: baseline([0.5, 0.51, 0.52]),
		});

	test("real improvement (beyond noise) → kept, best updated", () => {
		const s = recordAutoresearchRun(base(), { runId: "r1", hypothesis: "better", values: [0.3, 0.31, 0.32] });
		expect(s.runs[0]?.verdict).toBe("improvement");
		expect(s.runs[0]?.kept).toBe(true);
		expect(s.bestMean).toBeCloseTo(0.31, 5);
		expect(s.bestRunId).toBe("r1");
	});

	test("within noise → not kept, best unchanged", () => {
		const s = recordAutoresearchRun(base(), { runId: "r2", hypothesis: "same", values: [0.49, 0.51, 0.53] });
		expect(s.runs[0]?.verdict).toBe("noise");
		expect(s.runs[0]?.kept).toBe(false);
		expect(s.bestRunId).toBeUndefined();
		expect(s.bestMean).toBeCloseTo(0.51, 5);
	});

	test("regression → not kept", () => {
		const s = recordAutoresearchRun(base(), { runId: "r3", hypothesis: "worse", values: [0.7, 0.71, 0.72] });
		expect(s.runs[0]?.verdict).toBe("regression");
		expect(s.runs[0]?.kept).toBe(false);
	});

	test("a flagged suspected reward-hack is not kept even with a real improvement", () => {
		const s = recordAutoresearchRun(base(), {
			runId: "r4",
			hypothesis: "suspicious",
			values: [0.1, 0.11, 0.12],
			flags: ["eval tampered"],
		});
		expect(s.runs[0]?.verdict).toBe("improvement");
		expect(s.runs[0]?.kept).toBe(false);
		expect(s.bestRunId).toBeUndefined();
	});

	test("single seed cannot estimate noise → verdict noise (fail-closed, not progress)", () => {
		const s = recordAutoresearchRun(base(), { runId: "r5", hypothesis: "single", values: [0.3] });
		expect(s.runs[0]?.verdict).toBe("noise");
		expect(s.runs[0]?.kept).toBe(false);
	});

	test("ablation + falsification are recorded and surface in the summary (for model re-distill/re-design)", () => {
		const s = recordAutoresearchRun(base(), {
			runId: "r6",
			hypothesis: "conditional flow",
			values: [0.3, 0.31, 0.32],
			ablation: "conditioning head moved the needle",
			falsification: "direction still stands; overturn if unseen-compound split regresses",
		});
		expect(s.runs[0]?.ablation).toContain("conditioning head");
		expect(s.runs[0]?.falsification).toContain("unseen-compound");
		const text = summarizeAutoresearch(s);
		expect(text).toContain('ablation="conditioning head moved the needle"');
		expect(text).toContain("falsification=");
	});
});

describe("summarize + persist/load", () => {
	const state = () =>
		recordAutoresearchRun(
			initAutoresearch({
				evaluator: "yeast",
				version: 1,
				contentHash: "abc123",
				direction: "minimize",
				baseline: baseline([0.5, 0.51, 0.52]),
			}),
			{
				runId: "r1",
				hypothesis: "conditional flow",
				values: [0.3, 0.31, 0.32],
			},
		);

	test("summarize renders best/baseline/direction + the latest run (for model decisions)", () => {
		const text = summarizeAutoresearch(state());
		expect(text).toContain("direction=minimize");
		expect(text).toContain("baseline_mean=");
		expect(text).toContain("best_mean=0.310000");
		expect(text).toContain('"conditional flow"');
		expect(text).toContain("[improvement, kept]");
	});

	test("persist → load round-trips identically", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kea2-autoresearch-"));
		const s = state();
		await persistAutoresearch(dir, s);
		const loaded = await loadAutoresearch(dir, "yeast");
		expect(loaded?.bestMean).toBeCloseTo(0.31, 5);
		expect(loaded?.runs).toHaveLength(1);
		await rm(dir, { recursive: true, force: true });
	});

	test("persist writes atomically: no tmp file residue", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kea2-autoresearch-"));
		const s = state();
		await persistAutoresearch(dir, s);
		const entries = await readdir(join(dir, ".kea", "autoresearch"));
		expect(entries.some((e) => e.includes(".tmp-"))).toBe(false);
		expect(entries).toContain("yeast.json");
		await rm(dir, { recursive: true, force: true });
	});

	test("load returns undefined when missing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kea2-autoresearch-"));
		expect(await loadAutoresearch(dir, "missing")).toBeUndefined();
		await rm(dir, { recursive: true, force: true });
	});
});
