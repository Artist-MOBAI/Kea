import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionEnv } from "@kea/core";
import { afterAll, describe, expect, test } from "vitest";
import { buildReadme, createDeliveryPackage, DeliveryManifestSchema } from "../src/delivery.ts";
import { METRIC_VALUE_PATTERN, parseMetrics } from "../src/evaluator.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

const manifest = {
	title: "Thermoelectric SPR: Bi2Te3 filling fraction",
	claim: "Filling fraction x=0.25 maximizes zT in skutterudite analogs",
	falsificationCriterion: "refuted unless zT(x=0.25) beats adjacent compositions by ≥5%",
	evaluator: { name: "zte", version: 2, metric: "zt" },
	bestScore: 1.42,
	baselineScore: 1.1,
	seeds: [0, 1, 2],
	provenance: { dataset: "rMD17-subset", git: "abc123", seedPolicy: "3-seed mean" },
	novelty: {
		classification: "refines",
		method: "MP similar_known + MACE independent calculation",
		comparedAgainst: ["mp-34064"],
	},
};

describe("delivery package (M6)", () => {
	test("schema enforces falsificationCriterion (falsifiability presented)", () => {
		expect(() => DeliveryManifestSchema.parse({ ...manifest, falsificationCriterion: "" })).toThrow();
	});

	test("provenance must be non-empty (unprovenanced delivery rejected by schema)", () => {
		expect(() => DeliveryManifestSchema.parse({ ...manifest, provenance: {} })).toThrow(/provenance must be non-empty/);
	});

	test("novelty postGateCheck command actually runs: exit 0 → machineVerified true", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-deliver-"));
		const { env } = await createExecutionEnv(workdir);
		const candidate = {
			...manifest,
			novelty: {
				classification: "novel_candidate" as const,
				method: "structure match + MACE",
				comparedAgainst: [],
				structureMatched: true,
				independentCalculation: true,
				postGateCheck: { command: "true" },
			},
		};
		const dir = await createDeliveryPackage(workdir, "machine-verified", candidate, "echo hi", env);
		const novelty = (await Bun.file(join(dir, "novelty-verification.json")).json()) as {
			classification: string;
			machineVerified: boolean;
		};
		expect(novelty.machineVerified).toBe(true);
		expect(novelty.classification).toBe("novel_candidate");
	});

	test("novelty postGateCheck command fails → machineVerified false, downgraded to unverified", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-deliver-"));
		const { env } = await createExecutionEnv(workdir);
		const candidate = {
			...manifest,
			novelty: {
				classification: "novel_candidate" as const,
				method: "structure match + MACE",
				comparedAgainst: [],
				structureMatched: true,
				independentCalculation: true,
				postGateCheck: { command: "false" },
			},
		};
		const dir = await createDeliveryPackage(workdir, "machine-refuted", candidate, "echo hi", env);
		const novelty = (await Bun.file(join(dir, "novelty-verification.json")).json()) as {
			classification: string;
			machineVerified: boolean;
		};
		expect(novelty.machineVerified).toBe(false);
		expect(novelty.classification).toBe("unverified");
	});

	test("createDeliveryPackage generates the full Hyra contract set + novelty-verification", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-deliver-"));
		const dir = await createDeliveryPackage(workdir, "zte-finding", manifest, "bash evaluate.sh");

		for (const f of [
			"solution.json",
			"solve.sh",
			"score.py",
			"REPRODUCE.md",
			"baseline.json",
			"provenance.json",
			"novelty-verification.json",
			"requirements.lock",
		]) {
			expect(await Bun.file(join(dir, f)).exists(), f).toBe(true);
		}
		const solve = await Bun.file(join(dir, "solve.sh")).text();
		expect(solve).toContain("bash evaluate.sh");
		expect(solve).toContain("set -euo pipefail");
		const novelty = (await Bun.file(join(dir, "novelty-verification.json")).json()) as { classification: string };
		expect(novelty.classification).toBe("refines");
	});

	test("missing novelty defaults to unverified (no false reporting)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-deliver-"));
		const { novelty: _drop, ...rest } = manifest;
		const dir = await createDeliveryPackage(workdir, "no-novelty", rest, "echo hi");
		const novelty = (await Bun.file(join(dir, "novelty-verification.json")).json()) as { classification: string };
		expect(novelty.classification).toBe("unverified");
	});

	test("score.py METRIC regex is single-sourced with the harness: parses scientific notation 1e-5", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-deliver-"));
		const dir = await createDeliveryPackage(workdir, "metric-regex", manifest, "echo hi");
		const scorePy = await Bun.file(join(dir, "score.py")).text();
		// Single source of truth: the template interpolation matches harness METRIC_VALUE_PATTERN verbatim
		expect(scorePy).toContain(`=(${METRIC_VALUE_PATTERN})`);
		// harness side, same contract: scientific notation parses
		expect(parseMetrics("METRIC score=1e-5").get("score")).toBe(1e-5);

		// The generated score.py also parses 1e-5 in real Python (recomputation never drifts)
		const probe = [
			"import importlib.util",
			`spec = importlib.util.spec_from_file_location("score", ${JSON.stringify(join(dir, "score.py"))})`,
			"mod = importlib.util.module_from_spec(spec)",
			"spec.loader.exec_module(mod)",
			'm = mod.parse_metrics("METRIC score=1e-5\\nMETRIC neg=-2.5E+3\\nMETRIC plain=42\\nMETRIC inf=1e999")',
			'assert m["score"] == 1e-5, m',
			'assert m["neg"] == -2.5e3, m',
			'assert m["plain"] == 42.0, m',
			// Same contract as harness: overflowing literals (→ inf) are absent, never a score
			'assert "inf" not in m, m',
		].join("\n");
		const proc = Bun.spawn(["python3", "-c", probe], { stdout: "pipe", stderr: "pipe" });
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited, stderr).toBe(0);
	});

	test("REPRODUCE.md contains claim / falsification / reproduce command", () => {
		const readme = buildReadme(DeliveryManifestSchema.parse(manifest));
		expect(readme).toContain("Falsification criterion");
		expect(readme).toContain("./solve.sh");
		expect(readme).toContain("1.42");
	});

	test("solve.sh matches eval_cmd verbatim ($$/$& not eaten by replace) and is executable", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-deliver-"));
		const evalCmd = 'printf "METRIC score=$$ $& $100"';
		const dir = await createDeliveryPackage(workdir, "dollar-cmd", manifest, evalCmd);
		const solve = await Bun.file(join(dir, "solve.sh")).text();
		// Template promises solver/scorer never drift: $$ must not collapse to $, $& must not be replaced by the matched text
		expect(solve).toContain(evalCmd);
		const mode = (await stat(join(dir, "solve.sh"))).mode;
		expect(mode & 0o111).not.toBe(0); // README tells users to run ./solve.sh, so the exec bit must be set
	});
});
