import { join } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { ExecutionError, err, type ShellExecOptions } from "@earendil-works/pi-agent-core";
import {
	createExecutionEnv,
	HookBlockedError,
	isRetryableStreamError,
	type Kernel,
	runTurnWithTransientRetry,
	TRANSIENT_BACKOFF_MS,
	TRANSIENT_MAX,
	TurnDeadlineExceededError,
	withTurnDeadline,
} from "@kea/core";
import {
	buildPhasePrompt,
	checkProgram,
	determinePhase,
	lastAssistantTextOf,
	lastLoadBearingIndex,
	loadProgramStrict,
	packById,
	programPathIn,
	ROUND_JUDGE_MIN_REMAINING_MS,
	type RoundJudgeVerdict,
	removeProgram,
	runRoundJudge,
	saveProgram,
	settleComplete,
	settleRound,
} from "@kea/research";
import { programFormalizationPrompt } from "../program-formalize.ts";
import { escalateEpochWorkers, escalateFreshWorker } from "../program-fresh-worker.ts";
import { hookBlockedMessage } from "../tui/controllers/error-classify.ts";
import { isTransientRoundError } from "./mobai.ts";

export interface ProgramLoopOptions {
	objective?: string;
	cwd?: string;
	/**
	 * Round cap. Omitted = unlimited (the never-stop contract); "last round" framing is suppressed in
	 * prompts — it makes models write closing summaries instead of continuing.
	 */
	maxRounds?: number;
	wallClockMs?: number;
	transientBackoffMs?: number;
	discipline?: string;
	setProgramRound?: (round: number) => void;
	log?: (line: string) => void;
	/** Test hook: called after each round (default noop). */
	onRound?: (round: number) => void;
}

const FORMALIZE_MAX_ATTEMPTS = 3;
const FRESH_WORKER_MIN_MS = 120_000;

export interface ProgramReport {
	outcome: "complete" | "budget_exhausted" | "blocked" | "error";
	rounds: number;
	detail?: string;
}

/** Wall-clock-capped exec proxy (same contract as the mobai loop's budgetCappedEnv). */
function budgetCappedEnv(env: ExecutionEnv, remainingMs: () => number): ExecutionEnv {
	return new Proxy(env, {
		get(target, prop) {
			if (prop === "exec") {
				return (command: string, options?: ShellExecOptions) => {
					const remaining = remainingMs();
					if (remaining <= 0) {
						return Promise.resolve(
							err(new ExecutionError("timeout", "wall-clock budget exhausted before criterion command")),
						);
					}
					const cappedS = Math.min(options?.timeout ?? Number.POSITIVE_INFINITY, remaining / 1000);
					return target.exec(command, { ...options, timeout: cappedS });
				};
			}
			const value = Reflect.get(target, prop);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function blockedReport(reason: string, rounds: number): ProgramReport {
	const detail = hookBlockedMessage(reason);
	console.error(`error: ${detail}`);
	return { outcome: "error", rounds, detail };
}

export async function runProgramLoop(kernel: Kernel, options: ProgramLoopOptions): Promise<ProgramReport> {
	const startedAt = Date.now();
	// unlimited wall clock = Infinity deadline (withTurnDeadline skips the race; idle watchdog still guards hangs)
	const deadline = startedAt + (options.wallClockMs ?? Number.POSITIVE_INFINITY);
	const cwd = options.cwd ?? process.cwd();
	const mobaiDir = join(cwd, ".kea");
	const transientBackoffMs = options.transientBackoffMs ?? TRANSIENT_BACKOFF_MS;
	const { env: rawEnv } = await createExecutionEnv(cwd);
	const env = budgetCappedEnv(rawEnv, () => deadline - Date.now());

	const promptTurn = (text: string) =>
		runTurnWithTransientRetry(
			{
				prompt: (t) => kernel.prompt(t),
				waitForIdle: () => kernel.agent.waitForIdle(),
				errorMessage: () => kernel.agent.state.errorMessage,
			},
			text,
			{ backoffMs: transientBackoffMs },
		);

	// a formalization turn that ends with no program on disk is re-prompted (up to FORMALIZE_MAX_ATTEMPTS)
	// — one bad turn is not a verdict on the objective
	const pack = packById(options.discipline);
	if (options.objective) {
		const formalizePrompt = programFormalizationPrompt(options.objective, pack);
		for (let attempt = 1; attempt <= FORMALIZE_MAX_ATTEMPTS; attempt++) {
			if (Date.now() >= deadline) return { outcome: "budget_exhausted", rounds: 0, detail: "wall-clock cap reached" };
			options.log?.(`[formalize] attempt ${attempt}/${FORMALIZE_MAX_ATTEMPTS}`);
			try {
				const outcome = await withTurnDeadline(promptTurn(formalizePrompt), deadline, () => kernel.abort());
				if (outcome.error && !isRetryableStreamError(outcome.error)) {
					return { outcome: "error", rounds: 0, detail: outcome.error };
				}
			} catch (error) {
				if (error instanceof HookBlockedError) return blockedReport(error.reason, 0);
				if (error instanceof TurnDeadlineExceededError) {
					return { outcome: "budget_exhausted", rounds: 0, detail: "wall-clock cap reached during formalization" };
				}
				throw error;
			}
			if (await loadProgramStrict(mobaiDir)) break;
			if (attempt < FORMALIZE_MAX_ATTEMPTS) {
				options.log?.("[formalize] no .kea/program.json after the turn — re-prompting (start_program is required)");
			}
		}
		if (!(await loadProgramStrict(mobaiDir))) {
			return {
				outcome: "blocked",
				rounds: 0,
				detail: `formalization failed: no .kea/program.json after ${FORMALIZE_MAX_ATTEMPTS} attempts`,
			};
		}
	}

	let transientErrors = 0;
	let analysisDue = false; // refuted attack / pairing mismatch / judged abandonment last round → ANALYZE phase next round
	let pairing: Parameters<typeof settleRound>[0]["prev"]["pairing"];
	let phaseStuckState: Parameters<typeof settleRound>[0]["prev"]["phaseStuck"];
	let roundsSinceProgress = 0; // zero-progress counter driving the saturation ladder

	const maxRounds = options.maxRounds;
	// round stamps must be unique across processes (the journal persists): restarting at 1 would let
	// historical entries grant free progress in per-round attribution
	const initialProgram = await loadProgramStrict(mobaiDir);
	const firstRound = initialProgram ? initialProgram.journal.reduce((m, e) => Math.max(m, e.round), 0) + 1 : 1;
	// the cap is RELATIVE: it limits rounds ADDED BY THIS PROCESS; journal stamps stay absolute
	// (rendering uses the absolute last round number so the round tag stays coherent on continue)
	const lastPlannedRound = maxRounds === undefined ? undefined : firstRound + maxRounds - 1;
	const roundLabel = (round: number) => (lastPlannedRound === undefined ? `${round}` : `${round}/${lastPlannedRound}`);
	let lastRound = firstRound - 1; // journal head: the last real round if this process runs zero rounds
	// ProgramReport.rounds counts rounds ADDED BY THIS PROCESS (`round - firstRound + 1`); journal stamps stay absolute
	const roundsRan = (lastRunRound: number) => Math.max(0, lastRunRound - firstRound + 1);
	for (let round = firstRound; lastPlannedRound === undefined || round <= lastPlannedRound; round++) {
		if (Date.now() >= deadline)
			return { outcome: "budget_exhausted", rounds: roundsRan(round - 1), detail: "wall-clock cap reached" };
		lastRound = round;
		options.setProgramRound?.(round);

		const program = await loadProgramStrict(mobaiDir);
		if (!program)
			return { outcome: "blocked", rounds: roundsRan(round - 1), detail: "no program formalized (.kea/program.json)" };

		// Machine-check the program criteria first: completion is never model-claimed.
		const results = await checkProgram(cwd, env, program, (cmd) => kernel.reviewMobaiCommand(cmd));
		if (results.every((r) => r.passed)) {
			options.log?.(`[round ${round}] program criteria all pass → complete`);
			try {
				await saveProgram(mobaiDir, settleComplete(program, round, "criteria machine-verified"));
			} catch (error) {
				options.log?.(
					`[round ${round}] settleComplete failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return { outcome: "complete", rounds: roundsRan(round) };
		}

		const failing = results.filter((r) => !r.passed).map((r) => `- ${r.description} (${r.detail})`);
		const phase = determinePhase(program, analysisDue, roundsSinceProgress);

		// Epoch rung: the round's work goes to BLANK fresh workers — no in-session prompt (the in-session
		// model has narrated itself into a corner by this depth); workers stamp entries with the current round
		if (phase.kind === "epoch") {
			// epoch workers run for minutes — with < FRESH_WORKER_MIN_MS left they cannot finish before
			// the deadline, so settle budget_exhausted instead of launching them
			if (deadline - Date.now() < FRESH_WORKER_MIN_MS) {
				options.log?.(
					`[round ${roundLabel(round)}] epoch round, but remaining budget < ${FRESH_WORKER_MIN_MS / 1000}s — settling budget_exhausted without workers`,
				);
				return {
					outcome: "budget_exhausted",
					rounds: roundsRan(round - 1),
					detail: `wall-clock budget too low for epoch workers (< ${FRESH_WORKER_MIN_MS / 1000}s left)`,
				};
			}
			options.log?.(
				`[round ${roundLabel(round)}] phase=epoch focuses=${phase.focuses.join("+")} | criteria failing ${failing.length}/${results.length}`,
			);
			const landed = await escalateEpochWorkers(kernel, program, phase, mobaiDir, round);
			// no in-session text was judged this round: the breaker states do not carry over
			pairing = undefined;
			phaseStuckState = undefined;
			analysisDue = false;
			if (landed) {
				roundsSinceProgress = 0;
				options.log?.(`[round ${round}] epoch workers made load-bearing progress — stagnation counter reset`);
			} else {
				roundsSinceProgress++;
			}
			options.onRound?.(round);
			continue;
		}

		// persisted discipline wins (a metric program keeps its pack across processes); the CLI flag
		// only covers programs formalized before the field existed
		const prompt = buildPhasePrompt({
			program,
			phase,
			round,
			maxRounds: lastPlannedRound,
			failing,
			pack: packById(program.discipline ?? options.discipline),
			programPath: programPathIn(mobaiDir),
		});
		options.log?.(
			`[round ${roundLabel(round)}] phase=${phase.kind}${phase.kind === "attack" ? ` node=${phase.node.id} instrument=${phase.instrument.id}` : ""} | criteria failing ${failing.length}/${results.length}`,
		);

		try {
			const outcome = await withTurnDeadline(promptTurn(prompt), deadline, () => kernel.abort());
			if (outcome.error) {
				if (isTransientRoundError(outcome.error, transientErrors)) {
					transientErrors++;
					console.error(
						`warning: transient provider error in program loop, retrying round (${transientErrors}/${TRANSIENT_MAX}): ${outcome.error}`,
					);
					options.log?.(`[round ${round}] transient provider error (${transientErrors}/${TRANSIENT_MAX}) — retrying`);
					round--; // a network blip must not consume round budget
					await new Promise((resolve) => setTimeout(resolve, transientBackoffMs));
					continue;
				}
				return { outcome: "error", rounds: roundsRan(round), detail: outcome.error };
			}
		} catch (error) {
			if (error instanceof HookBlockedError) return blockedReport(error.reason, roundsRan(round));
			if (error instanceof TurnDeadlineExceededError) {
				options.log?.(`[round ${round}] wall-clock deadline hit mid-turn → budget_exhausted`);
				return { outcome: "budget_exhausted", rounds: roundsRan(round - 1), detail: "wall-clock cap reached mid-turn" };
			}
			throw error;
		}
		transientErrors = 0;
		options.onRound?.(round);

		// settle via the SHARED settle module — the TUI auto-continue path settles identically
		const after = await loadProgramStrict(mobaiDir);
		if (!after) return { outcome: "blocked", rounds: roundsRan(round), detail: "program disappeared mid-run" };
		const rechecked = await checkProgram(cwd, env, after, (cmd) => kernel.reviewMobaiCommand(cmd));
		if (rechecked.every((r) => r.passed)) {
			options.log?.(`[round ${round}] program criteria settled during the round → complete`);
			try {
				await saveProgram(mobaiDir, settleComplete(after, round, "criteria machine-verified"));
			} catch (error) {
				options.log?.(
					`[round ${round}] settleComplete failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return { outcome: "complete", rounds: roundsRan(round) };
		}

		const settled = settleRound({
			program: after,
			prev: { pairing, phaseStuck: phaseStuckState, analysisDue, roundsSinceProgress },
			phase,
			lastAssistantText: lastAssistantTextOf(kernel.agent.state.messages as never),
			round,
		});
		pairing = settled.next.pairing;
		phaseStuckState = settled.next.phaseStuck;
		analysisDue = settled.next.analysisDue;
		roundsSinceProgress = settled.next.roundsSinceProgress;

		if (settled.attackRefuted) {
			options.log?.(`[round ${round}] → attack refuted; next round ANALYZE`);
		}
		if (settled.mismatchDeclared || settled.pairingStuckForced) {
			options.log?.(
				`[round ${round}] → pairing mismatch${settled.mismatchDeclared ? " declared (INSTRUMENT_MISMATCH)" : ` stuck ×${settled.next.pairing?.repeats ?? 0}`} → next round ANALYZE`,
			);
		}
		if (settled.phaseStuckForced) {
			options.log?.(
				`[round ${round}] → phase ${phase.kind} stuck ×${settled.next.phaseStuck?.repeats ?? 0} → next round ANALYZE`,
			);
		}
		if (!settled.madeProgress && !analysisDue) {
			// Quiet round: judge FIRST (fresh-context semantic verdict — the engine never scans prose),
			// then the fresh-worker escalation. An epoch decision spawns nothing here — the next round IS
			// the epoch round.
			const quietDecision = determinePhase(after, false, roundsSinceProgress);
			if (quietDecision.kind === "epoch") {
				options.log?.(`[round ${round}] quiet round at epoch depth — epoch workers run next round`);
			} else {
				let verdict: RoundJudgeVerdict | undefined;
				if (deadline - Date.now() >= ROUND_JUDGE_MIN_REMAINING_MS) {
					const judgeController = new AbortController();
					try {
						verdict = await withTurnDeadline(
							runRoundJudge(
								kernel.subagents,
								{
									objective: after.objective,
									round,
									phaseKind: phase.kind,
									target: phase.kind === "attack" ? { id: phase.node.id, title: phase.node.title } : undefined,
									roundText: lastAssistantTextOf(kernel.agent.state.messages as never),
									journalDelta: after.journal.filter((e) => e.round === round).map((e) => e.description),
								},
								judgeController.signal,
							),
							deadline,
							() => judgeController.abort(),
						);
					} catch (error) {
						if (!(error instanceof TurnDeadlineExceededError)) throw error;
						options.log?.(`[round ${round}] wall-clock deadline hit during judge → budget_exhausted`);
						return {
							outcome: "budget_exhausted",
							rounds: roundsRan(round),
							detail: "wall-clock cap reached during escalation",
						};
					}
				}
				if (verdict?.classification === "abandonment" || verdict?.classification === "external_blocker") {
					analysisDue = true;
					options.log?.(
						`[round ${round}] → judge: ${verdict.classification}${verdict.missing_capability ? ` (missing: ${verdict.missing_capability})` : ""}; next round ANALYZE`,
					);
				} else if (deadline - Date.now() < FRESH_WORKER_MIN_MS) {
					options.log?.(
						`[round ${round}] quiet round, but remaining budget < ${FRESH_WORKER_MIN_MS / 1000}s — skipping fresh worker`,
					);
				} else {
					options.log?.(`[round ${round}] quiet round (no load-bearing work) → fresh worker escalation`);
					const landed = await escalateFreshWorker(kernel, after, quietDecision, mobaiDir, round);
					if (landed) {
						roundsSinceProgress = 0;
						options.log?.(`[round ${round}] fresh worker made load-bearing progress — stagnation counter reset`);
					}
				}
			}
		} else if (settled.madeProgress) {
			options.log?.(`[round ${round}] → load-bearing progress (journal index ${lastLoadBearingIndex(after)})`);
		}
	}

	// The final round's work may have settled the criteria; check once more before reporting exhaustion.
	// (Unlimited mode never exits the loop above — this tail only runs when a round cap was configured.)
	const finalProgram = await loadProgramStrict(mobaiDir);
	if (finalProgram) {
		const results = await checkProgram(cwd, env, finalProgram, (cmd) => kernel.reviewMobaiCommand(cmd));
		if (results.every((r) => r.passed)) {
			// settle complete IN THE LEDGER — returning without persisting leaves program.json "active"
			try {
				await saveProgram(mobaiDir, settleComplete(finalProgram, lastRound, "criteria machine-verified"));
			} catch (error) {
				options.log?.(`[tail] settleComplete failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return { outcome: "complete", rounds: roundsRan(lastRound) };
		}
	}
	return { outcome: "budget_exhausted", rounds: roundsRan(lastRound), detail: "round cap reached" };
}

/** Remove the program file (TUI /program clear; clear is abandon, complete is machine-set only). */
export async function abandonProgram(cwd: string): Promise<boolean> {
	return removeProgram(join(cwd, ".kea"));
}
