import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { METRIC_VALUE_PATTERN } from "./evaluator.ts";

export const DeliveryManifestSchema = z.object({
	title: z.string().min(1),
	claim: z.string().min(1),
	falsificationCriterion: z.string().min(1),
	evaluator: z.object({ name: z.string(), version: z.number(), metric: z.string() }),
	bestScore: z.number(),
	baselineScore: z.number(),
	seeds: z.array(z.number()).default([]),
	provenance: z
		.record(z.string(), z.unknown())
		.refine((p) => Object.keys(p).length > 0, "provenance must be non-empty"),
	novelty: z
		.object({
			classification: z.enum(["known", "refines", "contradicts", "novel_candidate", "unverified"]),
			method: z.string(),
			comparedAgainst: z.array(z.string()).default([]),
			structureMatched: z.boolean().optional(),
			independentCalculation: z.boolean().optional(),
			postGateCheck: z.object({ command: z.string().min(1) }).optional(),
		})
		.optional(),
});
export type DeliveryManifest = z.infer<typeof DeliveryManifestSchema>;

export function deliveryDir(cwd: string, name: string): string {
	return join(cwd, ".kea", "deliveries", name);
}

const SCORE_PY = `#!/usr/bin/env python3
"""Score contract: shared by solver and scorer — self-scoring and official scoring never diverge."""
import math, re, sys

def parse_metrics(stdout: str) -> dict:
    metrics = {}
    for line in stdout.splitlines():
        m = re.match(r"^METRIC\\s+([A-Za-z_][A-Za-z0-9_]*)=(${METRIC_VALUE_PATTERN})\\s*$", line.strip())
        if m:
            value = float(m.group(2))
            # Same rule as the harness (evaluator.ts parseMetrics): overflowing literals
            # like 1e999 parse to inf and are treated as absent, never as a score.
            if math.isfinite(value):
                metrics[m.group(1)] = value
    return metrics

if __name__ == "__main__":
    print("score contract: run solve.sh and parse METRIC lines with parse_metrics()")
`;

const SOLVE_SH = `#!/bin/bash
# Reproduction entry point: any reviewer can recompute with one command (./solve.sh).
set -euo pipefail
cd "$(dirname "$0")"
${"{{EVAL_CMD}}"}
`;

export function buildReadme(manifest: DeliveryManifest): string {
	return [
		`# ${manifest.title}`,
		"",
		`**Claim**: ${manifest.claim}`,
		"",
		`**Falsification criterion**: ${manifest.falsificationCriterion}`,
		"",
		`**Evaluator**: ${manifest.evaluator.name} v${manifest.evaluator.version} (metric: ${manifest.evaluator.metric})`,
		`**Best score**: ${manifest.bestScore} (baseline ${manifest.baselineScore}, seeds ${manifest.seeds.join(",") || "n/a"})`,
		"",
		"## Reproduction",
		"```sh",
		"./solve.sh   # or follow REPRODUCE.md step by step",
		"```",
		"",
		"## Verification artifacts",
		"- provenance.json — full record of data/code/seeds",
		"- novelty-verification.json — novelty verdict method and comparisons",
		"- baseline.json — any-time legal baseline",
	].join("\n");
}

export async function createDeliveryPackage(
	cwd: string,
	name: string,
	manifestInput: unknown,
	evalCmd: string,
	// required to machine-verify the postGateCheck command; absent = self-declared, not machine-verified
	env?: ExecutionEnv,
): Promise<string> {
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
		throw new Error(`Invalid delivery name "${name}" (must match [a-z0-9][a-z0-9_-]*, no path separators)`);
	}
	const manifest = DeliveryManifestSchema.parse(manifestInput);
	const dir = deliveryDir(cwd, name);
	await mkdir(dir, { recursive: true });

	await Bun.write(join(dir, "solution.json"), JSON.stringify(manifest, null, 2));
	// split/join instead of replace(): String.replace treats $-sequences in the
	// replacement specially ($$ → $, $& → matched text), which would silently
	// diverge solve.sh from the frozen eval_cmd.
	const solvePath = join(dir, "solve.sh");
	await Bun.write(solvePath, SOLVE_SH.split("{{EVAL_CMD}}").join(evalCmd));
	// Bun.write creates 0644; the documented ./solve.sh needs the exec bit.
	await chmod(solvePath, 0o755);
	await Bun.write(join(dir, "score.py"), SCORE_PY);
	await Bun.write(join(dir, "REPRODUCE.md"), buildReadme(manifest));
	await Bun.write(
		join(dir, "baseline.json"),
		JSON.stringify({ evaluator: manifest.evaluator, score: manifest.baselineScore, seeds: manifest.seeds }, null, 2),
	);
	await Bun.write(join(dir, "provenance.json"), JSON.stringify(manifest.provenance, null, 2));
	// novel_candidate post-gate enforced here: missing structure match + independent-calculation evidence downgrades to unverified (never silently pass unverified novelty)
	const novelty = manifest.novelty;
	let noveltyRecord: Record<string, unknown> =
		novelty !== undefined &&
		novelty.classification === "novel_candidate" &&
		!(novelty.structureMatched === true && novelty.independentCalculation === true)
			? { ...novelty, classification: "unverified" }
			: (novelty ?? { classification: "unverified", method: "not performed", comparedAgainst: [] });
	if (novelty?.postGateCheck) {
		// machine post-gate: the model may only claim "machine-verified" when the harness actually ran the command
		const machineVerified = await runPostGateCheck(novelty.postGateCheck.command, cwd, env);
		noveltyRecord = {
			...noveltyRecord,
			machineVerified,
			postGateCheck: { command: novelty.postGateCheck.command, machineVerified },
		};
		if (!machineVerified && noveltyRecord.classification === "novel_candidate") {
			noveltyRecord = { ...noveltyRecord, classification: "unverified" };
		}
	} else {
		noveltyRecord = {
			...noveltyRecord,
			machineVerified: false,
			machineVerification: "self-declared, not machine-verified",
		};
	}
	await Bun.write(join(dir, "novelty-verification.json"), JSON.stringify(noveltyRecord, null, 2));
	await Bun.write(join(dir, "requirements.lock"), `# lock your environment here (pip freeze / conda env export)\n`);
	return dir;
}

async function runPostGateCheck(command: string, cwd: string, env: ExecutionEnv | undefined): Promise<boolean> {
	if (!env) return false;
	try {
		const result = await env.exec(command, { cwd, timeout: 120 });
		return result.ok && result.value.exitCode === 0;
	} catch {
		return false;
	}
}
