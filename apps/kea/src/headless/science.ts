import { HookBlockedError, type Kernel, TRANSIENT_BACKOFF_MS, TRANSIENT_MAX, untrustedObjectiveBlock } from "@kea/core";
import { hookBlockedMessage } from "../tui/controllers/error-classify.ts";
import { isTransientRoundError } from "./mobai.ts";

export interface ScienceLoopOptions {
	/** the problem / competition task to investigate (optional: a resumed session continues from its own context) */
	problem?: string;
	cwd?: string;
	maxRounds: number;
	wallClockMs: number;
	/** Test hook: override the transient-error backoff (default TRANSIENT_BACKOFF_MS). */
	transientBackoffMs?: number;
}

export interface ScienceReport {
	outcome: "submitted" | "budget_exhausted" | "error";
	rounds: number;
	detail?: string;
}

export function scienceSeedPrompt(problem: string): string {
	return [
		"<science_round>",
		"You are in science mode: an autonomous investigation that distills a problem's decisive factors and drives them past SOTA.",
		"",
		untrustedObjectiveBlock(problem),
		"",
		"Work this loop until you have a final plan you can commit to:",
		"1. `science_plan`: distill the critical factors (what matters most + north-star target + current SOTA) and explore orthogonal hypotheses, converging to one falsifiable plan with `next_hypotheses`.",
		"2. Where an evaluator exists, freeze a baseline (`autoresearch_init`) and measure candidates (`autoresearch_step`) to track whether each beat the best metric beyond pooled seed noise. A single seed is a hypothesis; improvement within noise is not progress.",
		"3. Record falsified hypotheses and failed attempts in the journal; persist verified facts with `remember`.",
		"4. Re-distill and re-plan from surviving evidence: the plan's `next_hypotheses` seed the next round.",
		"5. When you have a final plan, call `submit_science_plan` to write it and leave science mode.",
		"</science_round>",
	].join("\n");
}

// anti-give-up: the loop only ends on submit_science_plan, a budget, or a fatal error — never on "hard"
export function scienceContinuationPrompt(args: { round: number; maxRounds: number }): string {
	return [
		"<science_round>",
		`Round: ${args.round}/${args.maxRounds}. The investigation is NOT finished.`,
		"",
		"Make concrete progress now:",
		"- Inspect the workspace and journal as authoritative.",
		"- Re-read the last plan's `next_hypotheses` and `falsification_criterion`, and run the evaluator to honestly measure progress.",
		"- Record falsified hypotheses and failed attempts in the journal; persist verified facts with `remember`.",
		"- Being stuck is NOT a reason to stop. If a direction is falsified, pivot to a different critical factor and re-plan (`science_plan`).",
		"- When you have a final plan, call `submit_science_plan` to write it and leave science mode.",
		"</science_round>",
	].join("\n");
}

/** Hook-block settlement: report on stderr + outcome "error" (exit code 1). */
function blockedReport(reason: string, rounds: number): ScienceReport {
	const detail = hookBlockedMessage(reason);
	console.error(`error: ${detail}`);
	return { outcome: "error", rounds, detail };
}

export async function runScienceLoop(kernel: Kernel, options: ScienceLoopOptions): Promise<ScienceReport> {
	const startedAt = Date.now();
	const deadline = startedAt + options.wallClockMs;
	const transientBackoffMs = options.transientBackoffMs ?? TRANSIENT_BACKOFF_MS;
	let seedPrompted = false;
	let transientErrors = 0;

	// Deadline watchdog: a science_plan orchestrator call carries no internal wall clock, so the cap must
	// preempt the in-flight round — abort propagates the run signal into the tool call's delegation tree
	const watchdog = setTimeout(() => kernel.agent.abort(), options.wallClockMs);

	kernel.setScienceMode(true);
	try {
		for (let round = 1; round <= options.maxRounds; round++) {
			if (Date.now() >= deadline) {
				return { outcome: "budget_exhausted", rounds: round - 1, detail: "wall-clock cap reached" };
			}

			// seed-vs-continue must be decided per attempt: a transient failure before the model saw the
			// task re-seeds on retry, never continues blind without the problem statement
			const seeded = !seedPrompted && !!options.problem;
			const promptText =
				seeded && options.problem
					? scienceSeedPrompt(options.problem)
					: scienceContinuationPrompt({ round, maxRounds: options.maxRounds });
			seedPrompted = true;

			try {
				await kernel.prompt(promptText);
			} catch (err) {
				if (err instanceof HookBlockedError) return blockedReport(err.reason, round);
				throw err;
			}
			await kernel.agent.waitForIdle();

			// submission (submit_science_plan) exits science mode — that is the model's commit signal
			if (!kernel.scienceMode) {
				return { outcome: "submitted", rounds: round };
			}

			const errorMessage = kernel.agent.state.errorMessage;
			if (errorMessage) {
				// the watchdog aborts the in-flight round at the deadline: that is budget exhaustion, not an error
				if (Date.now() >= deadline) {
					return {
						outcome: "budget_exhausted",
						rounds: round,
						detail: "wall-clock cap reached (in-flight round aborted)",
					};
				}
				if (isTransientRoundError(errorMessage, transientErrors)) {
					transientErrors++;
					console.error(
						`warning: transient provider error in science mode, retrying round (${transientErrors}/${TRANSIENT_MAX}): ${errorMessage}`,
					);
					round--; // a network blip must not consume real-work round budget
					if (seeded) seedPrompted = false; // the seed never reached the model intact: re-send it
					await new Promise((resolve) => setTimeout(resolve, transientBackoffMs));
					continue;
				}
				return { outcome: "error", rounds: round, detail: errorMessage };
			}
			transientErrors = 0;
		}

		// the model may submit during the final round's work: settle once more before reporting budget exhaustion
		if (!kernel.scienceMode) return { outcome: "submitted", rounds: options.maxRounds };
		return { outcome: "budget_exhausted", rounds: options.maxRounds, detail: "round cap reached" };
	} finally {
		clearTimeout(watchdog);
		// leave science mode on any non-submission exit so the flag never lingers after the loop
		if (kernel.scienceMode) kernel.setScienceMode(false);
	}
}
