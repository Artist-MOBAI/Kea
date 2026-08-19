import { type ExecutionEnv, ExecutionError, err, type ShellExecOptions } from "@earendil-works/pi-agent-core";
import {
	createExecutionEnv,
	HookBlockedError,
	isRetryableStreamError,
	type Kernel,
	TRANSIENT_BACKOFF_MS,
	TRANSIENT_MAX,
	TurnDeadlineExceededError,
	untrustedObjectiveBlock,
	withTurnDeadline,
} from "@kea/core";
import {
	attacksClosed,
	checkMobai,
	hasNewProgress,
	lastAssistantTextOf,
	loadMobai,
	type Mobai,
	mobaiContinuationPrompt,
	ROUND_JUDGE_MIN_REMAINING_MS,
	type RoundJudgeVerdict,
	runRoundJudge,
	saveMobai,
} from "@kea/research";
import { hookBlockedMessage } from "../tui/controllers/error-classify.ts";
import { FRESH_WORKER_PREAMBLE } from "./fresh-worker.ts";

export interface MobaiLoopOptions {
	objective?: string;

	cwd?: string;
	/** Round cap. Omitted = unlimited (never-stop contract, same semantics as the program loop). */
	maxRounds?: number;
	wallClockMs?: number;
	/** Test hook: override the transient-error backoff (default TRANSIENT_BACKOFF_MS). */
	transientBackoffMs?: number;
	log?: (line: string) => void;
}

export function isTransientRoundError(errorMessage: string, transientErrors: number): boolean {
	return isRetryableStreamError(errorMessage) && transientErrors < TRANSIENT_MAX;
}

function sleepMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MobaiReport {
	outcome: "complete" | "budget_exhausted" | "blocked" | "error";
	rounds: number;
	detail?: string;
}

// A criterion's own timeout (COMMAND_TIMEOUT_S) could bust --max-minutes: exec is proxied with
// timeout = min(original, remaining budget) and returns a timeout result when nothing is left.
// Only exec is proxied (the only method criteria use); other methods pass through bound to the target.
function budgetCappedEnv(env: ExecutionEnv, remainingMs: () => number): ExecutionEnv {
	return new Proxy(env, {
		get(target, prop, receiver) {
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
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function blockedReport(reason: string, rounds: number): MobaiReport {
	const detail = hookBlockedMessage(reason);
	console.error(`error: ${detail}`);
	return { outcome: "error", rounds, detail };
}

// progress is credited only when the subagent itself records it via log_progress — never fabricated from a summary
async function escalateWithFreshWorker(kernel: Kernel, mobai: Mobai, deadline: number): Promise<void> {
	const open = mobai.frontier.filter((p) => p.status === "open" && (p.kind ?? "attack") === "attack");
	const task = [
		FRESH_WORKER_PREAMBLE,
		`Immutable objective — never weaken or rewrite it:\n${untrustedObjectiveBlock(mobai.objective)}`,
		"The shared workspace is the long-term memory and source of truth. Inspect it before acting.",
		...(open.length > 0
			? [
					"Open frontier paths (each has a falsification criterion):",
					...open.map((p) => `- ${p.id}: ${p.description} (falsify: ${p.falsification_criterion})`),
				]
			: []),
		"Make concrete verifiable progress in the workspace: write code or files, run commands, verify the result.",
		"Record what you verified with log_progress so the harness can credit it — a summary alone is not progress.",
	].join("\n");
	const controller = new AbortController();
	try {
		await withTurnDeadline(
			kernel.subagents.run({ task, label: "mobai-fresh-worker", signal: controller.signal }),
			deadline,
			() => controller.abort(),
		);
	} catch (error) {
		if (error instanceof TurnDeadlineExceededError) throw error;
		// fail-open: a failed escalation round simply yields no credited progress
	}
}

// Invention phase: a fresh-context strategist that never sees the worker's abdication draft; ledger
// entries are written by the strategist itself — the schema, not prose, enforces admission
async function runSea(kernel: Kernel, mobai: Mobai, deadline: number): Promise<void> {
	const closed = mobai.frontier.filter((p) => p.status !== "open");
	const task = [
		FRESH_WORKER_PREAMBLE,
		`Immutable objective — never weaken or rewrite it:\n${untrustedObjectiveBlock(mobai.objective)}`,
		"The shared workspace and its current working tree are the long-term memory and source of truth. Inspect them before acting.",
		closed.length > 0
			? [
					"Closed attacks (do not retry):",
					...closed.map((p) => `- ${p.id} (${p.kind ?? "attack"}): ${p.description}`),
				].join("\n")
			: "No attacks are recorded yet.",
		"Fan out readers on distinct adjacent languages, not the closed set above: look for an object or a comparison that could translate this problem into another category.",
		"Delegate the readers in ONE parallel swarm call (spawn_swarm), never one-by-one — sequential readers exhaust your wall-clock before you can synthesize. Keep the fan-out small (2-4 readers) and reserve your final turns for synthesis and the ledger write.",
		"Then use log_progress with newPaths to record: the named obstruction for the closed class; a translation, or an instrument whose recovery states which existing result it recovers as a special case; and exactly one attack that uses only that object.",
		"Do not change the completion criteria. blocked is only for a missing credential, external dependency, permission, hardware, or unavailable data — difficulty is not blocked.",
	].join("\n\n");
	const controller = new AbortController();
	try {
		await withTurnDeadline(
			kernel.subagents.run({ task, profile: "planner", label: "mobai-sea", signal: controller.signal }),
			deadline,
			() => controller.abort(),
		);
	} catch (error) {
		if (error instanceof TurnDeadlineExceededError) throw error;
		// fail-open: the next trigger retries with a fresh strategist
	}
}

// Escalation awaits race the run deadline: without this, --max-minutes only bites once the subagents'
// own BudgetGuard ends. A deadline hit settles budget_exhausted; other failures stay fail-open inside
// the escalation helpers.
async function settleEscalation(
	escalation: Promise<void>,
	round: number,
	log?: (line: string) => void,
): Promise<MobaiReport | undefined> {
	try {
		await escalation;
		return undefined;
	} catch (error) {
		if (!(error instanceof TurnDeadlineExceededError)) throw error;
		log?.(`[round ${round}] wall-clock deadline hit during escalation → budget_exhausted`);
		return { outcome: "budget_exhausted", rounds: round, detail: "wall-clock cap reached during escalation" };
	}
}

export interface BlockedStreak {
	fingerprint: string;
	count: number;
}

export function nextBlockedStreak(
	prev: BlockedStreak,
	mobai: Pick<Mobai, "status"> & { blockedReason?: Mobai["blockedReason"] },
): { streak: BlockedStreak; terminal: boolean } {
	if (mobai.status !== "blocked" || !mobai.blockedReason) {
		return { streak: { fingerprint: "", count: 0 }, terminal: false };
	}
	const fingerprint = `${mobai.blockedReason.kind}: ${mobai.blockedReason.detail}`;
	const count = fingerprint === prev.fingerprint ? prev.count + 1 : 1;
	return { streak: { fingerprint, count }, terminal: count >= 3 };
}

export async function runMobaiLoop(kernel: Kernel, options: MobaiLoopOptions): Promise<MobaiReport> {
	const startedAt = Date.now();
	// unlimited wall clock = Infinity deadline (withTurnDeadline skips the race; idle watchdog still guards hangs)
	const deadline = startedAt + (options.wallClockMs ?? Number.POSITIVE_INFINITY);
	const maxRounds = options.maxRounds;
	const roundLabel = (round: number) => (maxRounds === undefined ? `${round}` : `${round}/${maxRounds}`);
	const cwd = options.cwd ?? process.cwd();
	const transientBackoffMs = options.transientBackoffMs ?? TRANSIENT_BACKOFF_MS;
	const { env: rawEnv } = await createExecutionEnv(cwd);
	const env = budgetCappedEnv(rawEnv, () => deadline - Date.now());

	if (options.objective) {
		const formalizationPrompt = [
			"Formalize the following objective as a machine-verifiable mobai using the start_goal tool.",
			"Decompose an impossible-in-one-step objective into a frontier of falsifiable attack paths (start_goal frontier), each with a falsification_criterion.",
			"The completion criterion must be the real completion gate (a formal proof, a command contract, or a metric contract) — never a smaller subset.",
			// triple defense (framing + <untrusted_objective> wrapper + escape): a hand-typed objective is data, never instructions
			`Objective:\n${untrustedObjectiveBlock(options.objective)}`,
		].join("\n");
		for (let attempt = 0; ; attempt++) {
			if (Date.now() >= deadline) {
				return { outcome: "budget_exhausted", rounds: 0, detail: "wall-clock cap reached" };
			}
			try {
				await withTurnDeadline(kernel.prompt(formalizationPrompt), deadline, () => kernel.abort());
			} catch (error) {
				if (error instanceof HookBlockedError) return blockedReport(error.reason, 0);
				if (error instanceof TurnDeadlineExceededError) {
					return { outcome: "budget_exhausted", rounds: 0, detail: "wall-clock cap reached during formalization" };
				}
				throw error;
			}
			await kernel.agent.waitForIdle();
			// a formalization-phase agent error (provider down, abort, …) must surface as error, not as "mobai not formalized"
			const formalizationError = kernel.agent.state.errorMessage;
			if (!formalizationError) break;
			if (!isRetryableStreamError(formalizationError) || attempt >= TRANSIENT_MAX) {
				return { outcome: "error", rounds: 0, detail: formalizationError };
			}
			console.error(
				`warning: transient provider error during formalization, retrying (${attempt + 1}/${TRANSIENT_MAX}): ${formalizationError}`,
			);
			await sleepMs(transientBackoffMs);
		}
	}

	let lastProgressCount = 0;
	let blockedStreak = { fingerprint: "", count: 0 };
	let transientErrors = 0;
	for (let round = 1; maxRounds === undefined || round <= maxRounds; round++) {
		if (Date.now() >= deadline) {
			return { outcome: "budget_exhausted", rounds: round - 1, detail: "wall-clock cap reached" };
		}

		const mobai = await loadMobai(cwd);
		if (!mobai) {
			return { outcome: "blocked", rounds: round - 1, detail: "mobai was not formalized (no .kea/mobai.json)" };
		}

		// A self-declared "blocked" terminates only after the SAME external reason persists across three
		// consecutive rounds; a single declaration is re-seeded active — stopping short is not a stop.
		const streakDecision = nextBlockedStreak(blockedStreak, mobai);
		blockedStreak = streakDecision.streak;
		if (streakDecision.terminal) {
			return {
				outcome: "blocked",
				rounds: round,
				detail: `persisting external blocker: ${streakDecision.streak.fingerprint}`,
			};
		}
		if (mobai.status === "blocked") {
			await saveMobai(cwd, { ...mobai, status: "active", blockedReason: undefined, updatedAt: Date.now() });
		}

		// mobai.json vanished/corrupted between load and check (TOCTOU): settle by cap semantics, never error
		let checked: Awaited<ReturnType<typeof checkMobai>>;
		try {
			checked = await checkMobai(cwd, env, (cmd) => kernel.reviewMobaiCommand(cmd));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return maxRounds !== undefined
				? { outcome: "budget_exhausted", rounds: round - 1, detail }
				: { outcome: "blocked", rounds: round - 1, detail };
		}
		if (checked.mobai.status === "complete") {
			return { outcome: "complete", rounds: round };
		}

		const failing = checked.results.filter((r) => !r.passed).map((r) => `- ${r.description} (${r.detail})`);
		options.log?.(
			`[round ${roundLabel(round)}] mobai round | criteria failing ${failing.length}/${checked.results.length}`,
		);
		try {
			await withTurnDeadline(
				kernel.prompt(mobaiContinuationPrompt({ round, maxRounds, objective: mobai.objective, failing })),
				deadline,
				() => kernel.abort(),
			);
		} catch (error) {
			if (error instanceof HookBlockedError) return blockedReport(error.reason, round);
			if (error instanceof TurnDeadlineExceededError) {
				options.log?.(`[round ${round}] wall-clock deadline hit mid-turn → budget_exhausted`);
				return { outcome: "budget_exhausted", rounds: round - 1, detail: "wall-clock cap reached mid-turn" };
			}
			throw error;
		}
		await kernel.agent.waitForIdle();

		const errorMessage = kernel.agent.state.errorMessage;
		if (errorMessage) {
			if (isTransientRoundError(errorMessage, transientErrors)) {
				transientErrors++;
				console.error(
					`warning: transient provider error, retrying round (${transientErrors}/${TRANSIENT_MAX}): ${errorMessage}`,
				);
				round--; // a network blip must not consume real-work round budget
				await sleepMs(transientBackoffMs);
				continue;
			}
			return { outcome: "error", rounds: round, detail: errorMessage };
		}
		transientErrors = 0;

		const afterRound = await loadMobai(cwd);
		const current = afterRound ?? mobai;

		// The worker may have settled the mobai itself (check_goal sets complete only when every machine
		// criterion passes) — settle immediately, never escalate against an already-complete mobai.
		if (current.status === "complete") {
			return { outcome: "complete", rounds: round };
		}

		// A fully closed attack set means the current language cannot see the mobai: fire the invention
		// phase (a phase change, never a stop). Prose is never scanned — a no-progress round goes through
		// the fresh-context semantic judge first (abandonment → sea; anything else → fresh worker).
		if (attacksClosed(current)) {
			options.log?.(`[round ${round}] → attacks closed; sea invention phase`);
			const settled = await settleEscalation(runSea(kernel, current, deadline), round, options.log);
			if (settled) return settled;
		} else if (afterRound && hasNewProgress(afterRound, lastProgressCount)) {
			options.log?.(`[round ${round}] → new verified progress`);
			lastProgressCount = afterRound.progress.length;
			continue;
		} else {
			// Semantic judge on the no-progress round (deadline-guarded like every escalation await);
			// abandonment → sea, anything else → fresh worker
			let verdict: RoundJudgeVerdict | undefined;
			if (deadline - Date.now() >= ROUND_JUDGE_MIN_REMAINING_MS) {
				const judgeController = new AbortController();
				try {
					verdict = await withTurnDeadline(
						runRoundJudge(
							kernel.subagents,
							{
								objective: current.objective,
								round,
								phaseKind: "attack",
								target: undefined,
								roundText: lastAssistantTextOf(kernel.agent.state.messages as never),
								journalDelta: current.progress.slice(-3).map((p) => p.description),
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
						rounds: round,
						detail: "wall-clock cap reached during escalation",
					};
				}
			}
			if (verdict?.classification === "abandonment") {
				options.log?.(`[round ${round}] → judge: abandonment; sea invention phase`);
				const settled = await settleEscalation(runSea(kernel, current, deadline), round, options.log);
				if (settled) return settled;
			} else {
				options.log?.(`[round ${round}] → no verifiable progress; fresh worker escalation`);
				// break the context lock with a fresh worker
				const settled = await settleEscalation(escalateWithFreshWorker(kernel, current, deadline), round, options.log);
				if (settled) return settled;
			}
		}

		// progress credit comes only from the ledger the subagent wrote, never from an interpreted summary
		const refreshed = await loadMobai(cwd);
		if (refreshed) lastProgressCount = refreshed.progress.length;
	}

	// Criteria may be satisfied only during the final round's work: checkMobai runs only at the start of each round,
	// so settle the machine criteria once more here, or a passing final round would be misreported as budget_exhausted (exit 2 instead of 0)
	const finalMobai = await loadMobai(cwd);
	if (finalMobai) {
		let rechecked: Awaited<ReturnType<typeof checkMobai>>;
		try {
			rechecked = await checkMobai(cwd, env, (cmd) => kernel.reviewMobaiCommand(cmd));
		} catch (error) {
			// TOCTOU: the ledger vanished/corrupted after the final load — settle by cap semantics, never error
			const detail = error instanceof Error ? error.message : String(error);
			return maxRounds !== undefined
				? { outcome: "budget_exhausted", rounds: maxRounds, detail }
				: { outcome: "blocked", rounds: 0, detail };
		}
		if (rechecked.mobai.status === "complete") return { outcome: "complete", rounds: maxRounds ?? 0 };
	}
	return { outcome: "budget_exhausted", rounds: maxRounds ?? 0, detail: "round cap reached" };
}
