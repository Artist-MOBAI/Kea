import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { getOrThrow } from "@earendil-works/pi-agent-core";
import { parseMetrics } from "../evaluator.ts";
import { reasonOf } from "../http.ts";
import { evaluateMobai } from "../mobai.ts";
import type { Acceptance, Program } from "./schema.ts";

// Machine verification (the only effectful part of the program core): runAcceptance executes a node's
// acceptance contract — a node may transition to `proved` only after it passes.

export interface AcceptanceResult {
	passed: boolean;
	detail: string;
}

export type CommandGate = (command: string) => "approve" | "deny" | "ask";

// Aligned with the bash-tool timeout ceiling (1h): acceptance contracts run Lean builds — a 600s cap
// made mathlib-scale nodes unprovable, not slow.
import { ACCEPTANCE_TIMEOUT_S } from "@kea/core";

export async function runAcceptance(
	workspace: string,
	env: ExecutionEnv,
	acceptance: Acceptance,
	gate?: CommandGate,
): Promise<AcceptanceResult> {
	const verdict = gate ? gate(acceptance.command) : "ask";
	if (verdict !== "approve") {
		return { passed: false, detail: `blocked by permission policy (${verdict}; not executed)` };
	}
	try {
		const result = getOrThrow(await env.exec(acceptance.command, { cwd: workspace, timeout: ACCEPTANCE_TIMEOUT_S }));
		if (acceptance.check === "command") {
			let passed = result.exitCode === acceptance.expect_exit;
			if (passed && acceptance.expect_stdout_contains !== undefined) {
				passed = result.stdout.includes(acceptance.expect_stdout_contains);
			}
			return { passed, detail: `exit=${result.exitCode}` };
		}
		const metrics = parseMetrics(result.stdout);
		const value = metrics.get(acceptance.metric);
		if (value === undefined) return { passed: false, detail: `METRIC ${acceptance.metric} not found` };
		const passed = acceptance.direction === "at_least" ? value >= acceptance.threshold : value <= acceptance.threshold;
		return { passed, detail: `${acceptance.metric}=${value}` };
	} catch (err) {
		return { passed: false, detail: reasonOf(err) };
	}
}

export interface ProgramCriterionResult {
	description: string;
	passed: boolean;
	detail: string;
}

// Deliberate boundary: a PURE READ — never settles or reverts program.status. Callers machine-RE-CHECK
// the criteria via this immediately before settleComplete + saveProgram, so "complete" on disk always
// means "criteria machine-verified at settle time".
export async function checkProgram(
	workspace: string,
	env: ExecutionEnv,
	program: Program,
	gate?: CommandGate,
): Promise<ProgramCriterionResult[]> {
	// evaluateMobai reads only mobai.criteria; the shim keeps one criterion engine instead of two.
	return evaluateMobai(
		workspace,
		env,
		{ criteria: program.criteria } as unknown as Parameters<typeof evaluateMobai>[2],
		gate,
	);
}
