import { type Kernel, untrustedObjectiveBlock } from "@kea/core";
import { epochBrief, loadProgram, type PhaseDecision, type Program, roundMadeProgress } from "@kea/research";
import { FRESH_WORKER_PREAMBLE } from "./headless/fresh-worker.ts";

// Shared by the headless program loop and the TUI auto-continue. Escalations spawn BLANK subagents
// (no parent conversation) so they never inherit the in-session model's narration anchor, and are
// fail-open — a single worker failure must not bubble. The optional AbortSignal reaches the subagent
// runs so the TUI can interrupt an in-flight escalation window.

function freshWorkerNodeText(decision: PhaseDecision): string {
	return decision.kind === "attack"
		? `Attack node: ${decision.node.id} — ${JSON.stringify(decision.node.statement)} (acceptance: ${decision.node.acceptance.description}); use ONLY instrument ${decision.instrument.id}'s primitives.`
		: decision.kind === "invent"
			? `Invent instrument v${decision.latestVersion + 1}: recovery contracts + novelty witness over the latest barrier, then calibrate.`
			: decision.kind === "reform"
				? decision.mode === "translate"
					? `Translate: propose cross-domain reformulations of the saturated leaves with machine-checkable bridges (implication nodes), then verify the most promising bridge.`
					: `Reformulate: weaken a premise via an implication node, or add a new definition, or restate a saturated leaf to a bounded acceptance.`
				: decision.kind === "extend"
					? `Extend: add the missing lemma chain (3 small machine-checkable nodes) and prove the first one.`
					: decision.kind === "replan"
						? `Replan: route around the refuted dependency with replacement nodes, then work the first replacement.`
						: "Analyze the frontier: quantify the precise barrier, record it with its machine check, register the next instrument draft.";
}

async function spawnWorker(kernel: Kernel, task: string, label: string, signal?: AbortSignal): Promise<void> {
	try {
		await kernel.subagents.run({ task, label, signal });
	} catch {
		// fail-open: an escalation round that yields nothing is retried next round
	}
}

// An `epoch` decision spawns nothing here (epoch rounds run their own workers — pre-running would
// duplicate the focus); returns whether load-bearing work stamped with `round` landed
export async function escalateFreshWorker(
	kernel: Kernel,
	program: Program,
	decision: PhaseDecision,
	mobaiDir: string,
	round: number,
	signal?: AbortSignal,
): Promise<boolean> {
	// An empty-journal caller passes 0; journal rounds are schema-positive — the attribution round
	// floors at 1 so worker-landed entries can never be credited to (or stamped as) round 0.
	const stampedRound = Math.max(1, round);
	if (decision.kind === "epoch") return false;
	const task = [
		FRESH_WORKER_PREAMBLE,
		`Immutable objective — never weaken or rewrite it:\n${untrustedObjectiveBlock(program.objective)}`,
		"The shared workspace is the long-term memory and source of truth. Inspect it before acting.",
		"Do not call start_program — a program already exists; continue it.",
		freshWorkerNodeText(decision),
		"Make concrete verifiable progress, then record it with update_node / program_note so the harness can credit it.",
	].join("\n");
	await spawnWorker(kernel, task, "program-fresh-worker", signal);
	// recheck after the worker: attribution is by the SAME round stamp, and with no scheduled target
	// ANY load-bearing entry (prove/calibrate/barrier) counts
	const refreshed = await loadProgram(mobaiDir);
	return refreshed !== undefined && roundMadeProgress(refreshed, stampedRound, undefined);
}

// One blank worker per focus axis, in parallel; returns whether ANY worker landed load-bearing work stamped with `round`
export async function escalateEpochWorkers(
	kernel: Kernel,
	program: Program,
	decision: Extract<PhaseDecision, { kind: "epoch" }>,
	mobaiDir: string,
	round: number,
	signal?: AbortSignal,
): Promise<boolean> {
	// Same floor as escalateFreshWorker: journal rounds are schema-positive, never 0.
	const stampedRound = Math.max(1, round);
	await Promise.all(
		decision.focuses.map((focus) =>
			spawnWorker(kernel, epochBrief(focus, program, { preamble: FRESH_WORKER_PREAMBLE }), `epoch-${focus}`, signal),
		),
	);
	const refreshed = await loadProgram(mobaiDir);
	return refreshed !== undefined && roundMadeProgress(refreshed, stampedRound, undefined);
}
