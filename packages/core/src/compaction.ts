import type { AgentMessage, Entry } from "@earendil-works/pi-agent-core";
import {
	type CompactionSettings,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	prepareCompaction,
	uuidv7,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "./context-size.ts";
import { err, ok, type Result } from "./errors.ts";
import { isRetryableStreamError, retryBackoffDelayMs, sleepAbortable } from "./retry.ts";
import { type KeaSession, MAIN_LANE, sanitizeDurable } from "./session.ts";
import { isHarnessPromptText, isSystemReminderText } from "./text.ts";

export const COMPACTION_SETTINGS: CompactionSettings = {
	...DEFAULT_COMPACTION_SETTINGS,
	enabled: true,
	reserveTokens: 50_000,
};

export const COMPACTION_TRIGGER_RATIO = 0.85;

// Hard wall for one compaction summary request: it is a single completion (not a streamed turn), so the
// streamed-turn idle watchdog never covers it.
const SUMMARY_TIMEOUT_MS = 300_000;
const SUMMARY_RETRIES = 2;

function summaryAbortError(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new Error("compaction summary aborted");
}

/**
 * Bounded retry wrapper around models.completeSimple for the compaction summary call.
 * - Providers surface failures BOTH as rejections and as RESOLVED stopReason:"error" messages: retryable
 *   resolved errors run the same bounded backoff, otherwise compaction would accept an error text as the summary.
 * - The per-attempt hard wall is merged into the request signal (AbortSignal.any): firing it aborts the
 *   underlying completion, not just this wrapper's race.
 */
export function withSummaryGuard(models: Models, timeoutMs = SUMMARY_TIMEOUT_MS): Models {
	const complete = models.completeSimple.bind(models);
	return {
		...models,
		async completeSimple(...args: Parameters<Models["completeSimple"]>): ReturnType<Models["completeSimple"]> {
			const callerSignal = args[2]?.signal;
			for (let attempt = 0; ; attempt++) {
				if (callerSignal?.aborted) throw summaryAbortError(callerSignal);
				const wall = new AbortController();
				const signal = AbortSignal.any(callerSignal ? [callerSignal, wall.signal] : [wall.signal]);
				try {
					const message = await new Promise<AssistantMessage>((resolve, reject) => {
						const timer = setTimeout(() => {
							wall.abort();
							reject(new Error(`compaction summary request timed out after ${Math.round(timeoutMs / 1000)}s`));
						}, timeoutMs);
						const settle = (fn: () => void): void => {
							clearTimeout(timer);
							callerSignal?.removeEventListener("abort", onAbort);
							fn();
						};
						const onAbort = (): void => settle(() => reject(summaryAbortError(callerSignal)));
						callerSignal?.addEventListener("abort", onAbort, { once: true });
						complete(args[0], args[1], { ...args[2], signal }).then(
							(value) => settle(resolve.bind(null, value)),
							(error) => settle(reject.bind(null, error)),
						);
					});
					const resolvedError = message.stopReason === "error" ? (message.errorMessage ?? "") : "";
					if (
						resolvedError === "" ||
						!isRetryableStreamError(resolvedError) ||
						attempt >= SUMMARY_RETRIES ||
						callerSignal?.aborted === true
					) {
						return message;
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (callerSignal?.aborted || attempt >= SUMMARY_RETRIES || !isRetryableStreamError(message)) throw error;
				}
				await sleepAbortable(retryBackoffDelayMs(attempt), callerSignal);
			}
		},
	} as Models;
}

// pi's chars/4 estimator undercounts CJK-heavy sessions ~4x: scale keepRecentTokens by the observed density
// factor so pi's own cut point lands within the REAL token budget (no post-hoc trimming — every cut message
// goes through the summary, nothing is silently dropped).
export function adaptiveKeepRecentTokens(messages: readonly Entry[], settings: CompactionSettings): number {
	const budget = settings.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens ?? 20_000;
	let piTokens = 0;
	let realTokens = 0;
	for (const entry of messages) {
		if (entry.type !== "message") continue;
		piTokens += estimateTokens(entry.message);
		realTokens += estimateMessageTokens(entry.message);
	}
	if (piTokens <= 0 || realTokens <= 0) return budget;
	const densityFactor = realTokens / piTokens; // ≥1 when pi undercounts (CJK-heavy), ~1 for ASCII
	return Math.max(1_000, Math.min(budget, Math.round(budget / densityFactor)));
}

// Reminder-channel injections never survive into the retained tail: providers re-announce current state right
// after compaction, so keeping them would only stack stale copies against the re-injected ones.
export function isReminderOnlyMessage(message: AgentMessage): boolean {
	if (!("role" in message) || message.role !== "user") return false;
	const content = message.content;
	if (typeof content === "string") return isSystemReminderText(content);
	if (!Array.isArray(content) || content.length === 0) return false;
	if (!content.every((block) => block.type === "text")) return false;
	return isSystemReminderText(content.map((block) => (block.type === "text" ? block.text : "")).join(""));
}

// Harness round prompts (program/mobai continuations, recovery text) never survive into the retained tail:
// the engine regenerates the next round prompt from the ledger, so retained copies are only stale weight.
// Unlike reminders these are NOT re-injected after compaction — the owning loop re-derives the round from
// durable state.
export function isHarnessPromptMessage(message: AgentMessage): boolean {
	if (!("role" in message) || message.role !== "user") return false;
	const content = message.content;
	if (typeof content === "string") return isHarnessPromptText(content);
	if (!Array.isArray(content) || content.length === 0) return false;
	if (!content.every((block) => block.type === "text")) return false;
	return isHarnessPromptText(content.map((block) => (block.type === "text" ? block.text : "")).join(""));
}

export const RESEARCH_SUMMARY_INSTRUCTIONS = [
	"Write a first-person handoff note to yourself: a fresh instance of you will continue this research from the note alone.",
	"",
	"Preserve EXACTLY (never paraphrase numbers or identifiers):",
	"- Every hypothesis with its current status (proposed / under_test / supported / refuted / abandoned) and belief direction.",
	"- Metric names, values, directions, seeds, and the evaluator contract name/version that produced them.",
	"- Dataset paths/versions, checkpoint ids, and any parameter that would change a result if guessed wrong.",
	"- Falsified hypotheses and FAILED attempts with the reason they failed — negative results prevent re-exploration and must survive.",
	"- Open blockers and the exact next step (the command or tool call to run first).",
	"",
	"Drop: raw tool output, verbatim file contents, and intermediate reasoning that led nowhere.",
	"",
	"Honesty rules:",
	"- Anything you did not actually verify gets marked (unverified). Never launder a claim into a fact by summarizing.",
	"- Do not answer questions posed in the conversation; do not continue the research. Only write the handoff note.",
	"",
	"Write the handoff itself — no mention of this summarization request or of the context being compacted.",
	"",
	"Respond with text only. Do not call any tools.",
].join("\n");

export function composeCompactionInstructions(instruction?: string): string {
	return instruction ? `${instruction}\n\n${RESEARCH_SUMMARY_INSTRUCTIONS}` : RESEARCH_SUMMARY_INSTRUCTIONS;
}

// Compaction trigger (dual condition): `used >= window × triggerRatio` OR `used + reserveTokens >= window` —
// the reserve doubles as the output budget, so a request plus its completion can never outgrow the window once
// compaction fired. Takes the token count directly; callers decide the metric.
export function contextNeedsCompaction(
	tokens: number,
	contextWindow: number | undefined,
	settings: CompactionSettings = COMPACTION_SETTINGS,
): boolean {
	if (!settings.enabled || !contextWindow || contextWindow <= 0) return false;
	if (tokens >= contextWindow * COMPACTION_TRIGGER_RATIO) return true;
	// clamp the reserve to ~15% of the window: a small custom window (≤ reserveTokens) would otherwise make
	// `tokens + reserve >= window` trivially true at any usage and spin compaction on every turn
	const reserve = Math.min(settings.reserveTokens, Math.floor(contextWindow * (1 - COMPACTION_TRIGGER_RATIO)));
	return tokens + reserve >= contextWindow;
}

export interface CompactionApplied {
	tokensBefore: number;
}

export async function runCompaction(args: {
	session: KeaSession;
	entries: Entry[];
	models: Models;
	model: Model<Api>;
	settings?: CompactionSettings;
	signal?: AbortSignal;
	instruction?: string;
}): Promise<Result<CompactionApplied>> {
	const { session, entries, models, model, signal, instruction } = args;
	const settings = args.settings ?? COMPACTION_SETTINGS;
	const adaptiveSettings: CompactionSettings = {
		...settings,
		keepRecentTokens: adaptiveKeepRecentTokens(entries, settings),
	};

	const prepResult = prepareCompaction(entries, adaptiveSettings);
	if (!prepResult.ok) return err(prepResult.error.message);
	const preparation = prepResult.value;
	if (!preparation) return err("nothing to compact");

	const summaryInstructions = composeCompactionInstructions(instruction);
	const compactResult = await compact(preparation, withSummaryGuard(models), model, summaryInstructions, signal);
	if (!compactResult.ok) return err(compactResult.error.message);
	const { summary, retainedTail, tokensBefore, usage, details } = compactResult.value;

	if (summary.trim().length === 0) return err("compaction guard: empty summary rejected");
	if (retainedTail.length === 0 && preparation.messagesToSummarize.length === 0) {
		return err("compaction guard: nothing summarized");
	}
	// drop reminder injections and harness round prompts from the tail: both are re-derived after compaction,
	// retained copies would only be stale duplicates burning tokens
	const tail = retainedTail.filter((m) => !isReminderOnlyMessage(m) && !isHarnessPromptMessage(m));

	const entry: {
		type: "compaction";
		id: string;
		summary: string;
		retainedTail: typeof retainedTail;
		tokensBefore: number;
		usage?: typeof usage;
		details?: unknown;
	} = { type: "compaction", id: uuidv7(), summary, retainedTail: tail, tokensBefore };
	if (usage) entry.usage = usage;
	if (details !== undefined) entry.details = details;
	// usage/details come from pi compact()'s unknown domain: sanitize before the durable write
	await session.appendEntry(sanitizeDurable(entry), MAIN_LANE);
	return ok({ tokensBefore });
}
