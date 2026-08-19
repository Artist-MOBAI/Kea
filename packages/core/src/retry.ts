import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";

// Model stream request retry:
// - exponential backoff: 500ms ×2, capped at 32s, 25% jitter;
// - retry only before "any content event has been produced" — mid-stream failures are forwarded as-is (retrying
//   would duplicate content);
// - retries apply only to HTTP stream attempts, never touching the session ledger (the user message is written once);
// - interruptible via AbortSignal; auth/quota errors are not retried;
// - StreamFn contract: every exit path ends with a terminal message — done/error events are forwarded as-is,
//   thrown errors become error events, abort yields terminal stopReason="aborted"; never a bare end().

export const RETRY_MAX_ATTEMPTS = 10;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;
const RETRY_FACTOR = 2;
const JITTER_FACTOR = 0.25;

const NETWORK_RE =
	/network|connection|connect|disconnect|terminated|fetch failed|econnrefused|econnreset|enotfound|etimedout|socket hang up/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;
const RETRYABLE_STATUS_RE = /\b(408|409|429|500|502|503|504|529)\b/;
// auth/quota errors are pointless to retry
const NON_RETRYABLE_RE = /quota|insufficient|payment|unauthorized|invalid api key|authentication|\b401\b|\b403\b/i;

export function isRetryableStreamError(message: string): boolean {
	if (NON_RETRYABLE_RE.test(message)) return false;
	return NETWORK_RE.test(message) || TIMEOUT_RE.test(message) || RETRYABLE_STATUS_RE.test(message);
}

// Context-overflow detection: a 400/413/422 whose message says the request exceeded the model context window.
// Deliberately NOT part of isRetryableStreamError — a blind retry re-sends the same oversized request and 400s
// again; the only correct recovery is compaction followed by a retry (kernel run chain).
const CONTEXT_OVERFLOW_PATTERNS = [
	/maximum context/i,
	/context[ _-]?length/i,
	/context[ _-]?window.*exceed/i,
	/exceed.*context[ _-]?window/i,
	/too many tokens/i,
	/reduce the length of the messages/i,
	/prompt is too long/i,
	/exceed(?:ed|s|ing)?\s+(?:the\s+)?max(?:imum)?\s*tokens?/i,
	/context[ _-]?length[ _-]?exceed/i,
	/input.*exceeds?.*(?:context|limit|maximum)/i,
	/token.*limit.*exceed/i,
];

export function isContextOverflowError(message: string): boolean {
	return CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(message));
}

// Consecutive overflow→compaction cycles before the run settles as a terminal context_overflow.
export const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;

// Window self-calibration ratio after an observed overflow.
export const OVERFLOW_CONTEXT_SAFETY_RATIO = 0.85;

/** Continuation injected after emergency compaction when the failed run left no resumable tail. */
export const OVERFLOW_CONTINUE_TEXT =
	"The previous request exceeded the model context window and the conversation was compacted automatically. Continue the task from the summary.";

export function retryBackoffDelayMs(attempt: number): number {
	const base = Math.min(BASE_DELAY_MS * RETRY_FACTOR ** attempt, MAX_DELAY_MS);
	return Math.round(base + Math.random() * JITTER_FACTOR * base);
}

// One turn of transient retry: streamWithRetry deliberately does NOT retry once content has been produced
// (re-issuing would duplicate the partial response). Mid-stream socket drops therefore surface as a failed
// turn — this helper re-runs the TURN with a continuation prompt instead, so TUI / kea run / subagents all
// recover from a single network blip without duplicating content.
export const TRANSIENT_TURN_MAX = 5;
export const TRANSIENT_TURN_BACKOFF_MS = 5_000;
export const TRANSIENT_CONTINUE_TEXT =
	"The previous response was interrupted by a transient network error; continue from where you left off.";

// Consecutive transient round errors a loop tolerates before settling as a terminal provider failure
// (shared by the headless program/mobai/science loops).
export const TRANSIENT_MAX = 5;
export const TRANSIENT_BACKOFF_MS = 5_000;

export interface TransientTurnHost {
	prompt(text: string): Promise<unknown>;
	waitForIdle(): Promise<void>;
	errorMessage(): string | undefined;
}

export interface TransientTurnResult {
	error?: string;
	attempts: number;
}

export async function runTurnWithTransientRetry(
	host: TransientTurnHost,
	initialText: string,
	opts: { maxAttempts?: number; backoffMs?: number; continueText?: string; signal?: AbortSignal } = {},
): Promise<TransientTurnResult> {
	const maxAttempts = Math.max(1, opts.maxAttempts ?? TRANSIENT_TURN_MAX);
	let text = initialText;
	let error: string | undefined;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (opts.signal?.aborted) return { error: "aborted", attempts: attempt };
		await host.prompt(text);
		await host.waitForIdle();
		error = host.errorMessage();
		if (error === undefined) return { attempts: attempt + 1 };
		if (!isRetryableStreamError(error)) return { error, attempts: attempt + 1 };
		text = opts.continueText ?? TRANSIENT_CONTINUE_TEXT;
		if (attempt < maxAttempts - 1) await sleepAbortable(opts.backoffMs ?? TRANSIENT_TURN_BACKOFF_MS, opts.signal);
	}
	return { error, attempts: maxAttempts };
}

export interface RetryInfo {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

/** Thrown by withTurnDeadline when the wall-clock budget runs out mid-turn (loop reports budget_exhausted). */
export class TurnDeadlineExceededError extends Error {
	constructor() {
		super("wall-clock budget exhausted mid-turn");
		this.name = "TurnDeadlineExceededError";
	}
}

// Race a model turn against the run's wall-clock deadline: the deadline must bound the turn ITSELF, not only
// the gaps between turns, or one long round can overrun --max-minutes arbitrarily. On expiry the caller's
// abort() fires (kernel.abort → run settles as aborted) and the race rejects.
export async function withTurnDeadline<T>(turn: Promise<T>, deadlineMs: number, abort: () => void): Promise<T> {
	// unlimited budget (deadline Infinity): no race — the idle watchdog is the only hang protection
	if (!Number.isFinite(deadlineMs)) return turn;
	const remaining = deadlineMs - Date.now();
	if (remaining <= 0) {
		abort();
		throw new TurnDeadlineExceededError();
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const exceeded = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			abort();
			reject(new TurnDeadlineExceededError());
		}, remaining);
	});
	try {
		return await Promise.race([turn, exceeded]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export interface StreamRetryOptions {
	maxAttempts?: number;
	signal?: AbortSignal;
	onRetry?: (info: RetryInfo) => void;
	/** Used to convert a thrown error into an error event: caller synthesizes the terminal message for the current model */
	makeErrorMessage?: (errorMessage: string) => AssistantMessage;
	// Idle watchdog: abort a stream that produces NO events for this long (a silently hung connection never
	// errors on its own). The synthesized "stream idle timeout" error is retry-classified like any timeout.
	// Default STREAM_IDLE_TIMEOUT_MS; 0 disables.
	idleTimeoutMs?: number;
}

import { STREAM_IDLE_TIMEOUT_MS } from "./timeouts.ts";

export { STREAM_IDLE_TIMEOUT_MS };

// Wrap an event stream so that waiting longer than `timeoutMs` for the NEXT event rejects. On timeout the
// underlying iterator is released explicitly — for-await does NOT call return() when next() rejects, so without
// this a timed-out request keeps its (possibly hung) socket pinned.
function withIdleTimeout(stream: AssistantMessageEventStream, timeoutMs: number): AsyncIterable<AssistantMessageEvent> {
	if (timeoutMs <= 0) return stream;
	const iterator = stream[Symbol.asyncIterator]();
	return {
		[Symbol.asyncIterator]: () => ({
			next: () => {
				const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<AssistantMessageEvent>>();
				const timer = setTimeout(() => {
					void iterator.return?.().catch(() => {});
					reject(new Error(`stream idle timeout: no events for ${Math.round(timeoutMs / 1000)}s`));
				}, timeoutMs);
				iterator.next().then(
					(result) => {
						clearTimeout(timer);
						resolve(result);
					},
					(err) => {
						clearTimeout(timer);
						reject(err);
					},
				);
				return promise;
			},
			return: (value) => iterator.return?.(value) ?? Promise.resolve({ done: true, value }),
			throw: (err) => iterator.throw?.(err) ?? Promise.reject(err),
		}),
	};
}

export function sleepAbortable(delayMs: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Error terminal assistant-message synthesis: kernel/subagent streamFn error paths and this file's fallback share the same shape (zero usage + stopReason error). */
export function makeErrorAssistantMessage(
	model: Pick<Model<Api>, "api" | "provider" | "id">,
	errorMessage: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

function fallbackErrorMessage(errorMessage: string): AssistantMessage {
	return makeErrorAssistantMessage({ api: "unknown", provider: "unknown", id: "unknown" }, errorMessage);
}

function abortReasonText(signal?: AbortSignal): string {
	const reason = signal?.reason;
	if (typeof reason === "string" && reason !== "") return reason;
	if (reason instanceof Error && reason.message !== "") return reason.message;
	return "aborted";
}

export function streamWithRetry(
	factory: () => Promise<AssistantMessageEventStream> | AssistantMessageEventStream,
	options: StreamRetryOptions = {},
): AssistantMessageEventStream {
	const maxAttempts = Math.max(1, options.maxAttempts ?? RETRY_MAX_ATTEMPTS);
	const idleTimeoutMs = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
	const signal = options.signal;
	const out = createAssistantMessageEventStream();

	// terminal wrap-up: push the terminal event and end with the same terminal message (push already resolves result(); end is just a fallback)
	const finishError = (error: AssistantMessage, reason: "error" | "aborted"): void => {
		out.push({ type: "error", reason, error } satisfies AssistantMessageEvent);
		out.end(error);
	};
	const finishThrown = (errorMessage: string): void => {
		finishError(options.makeErrorMessage?.(errorMessage) ?? fallbackErrorMessage(errorMessage), "error");
	};
	const finishAborted = (): void => {
		const base = options.makeErrorMessage?.(abortReasonText(signal)) ?? fallbackErrorMessage("aborted");
		finishError({ ...base, stopReason: "aborted", errorMessage: base.errorMessage ?? "aborted" }, "aborted");
	};

	void (async () => {
		for (let attempt = 0; ; attempt++) {
			if (signal?.aborted) return finishAborted();

			let sawContent = false;
			let retryMessage: string | undefined;
			try {
				const stream = await factory();
				let terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined;
				for await (const event of withIdleTimeout(stream, idleTimeoutMs)) {
					if (event.type === "done" || event.type === "error") {
						terminal = event;
						break;
					}
					// "start" carries the empty partial message — NOT content. Counting it would erase the
					// retry-before-content window (a blip between start and the first delta must retry the stream).
					if (event.type !== "start") sawContent = true;
					out.push(event);
				}

				if (terminal?.type === "done") {
					out.push(terminal);
					return out.end(terminal.message);
				}
				if (terminal?.type === "error") {
					const errorMessage = terminal.error.errorMessage ?? "";
					const aborted = terminal.reason === "aborted" || signal?.aborted === true;
					const canRetry = !aborted && !sawContent && attempt < maxAttempts - 1 && isRetryableStreamError(errorMessage);
					if (!canRetry) {
						out.push(terminal);
						return out.end(terminal.error);
					}
					// discard this stream (no events were forwarded) and enter backoff retry
					retryMessage = errorMessage;
				} else {
					// upstream broke the stream without a terminal event: fail closed with an error, never a bare end()
					return finishThrown("stream ended without a terminal event");
				}
			} catch (err) {
				if (signal?.aborted) return finishAborted();
				const message = err instanceof Error ? err.message : String(err);
				if (sawContent || attempt >= maxAttempts - 1 || !isRetryableStreamError(message)) {
					return finishThrown(message);
				}
				retryMessage = message;
			}

			const delayMs = retryBackoffDelayMs(attempt);
			options.onRetry?.({ attempt: attempt + 1, maxAttempts, delayMs, errorMessage: retryMessage ?? "" });
			try {
				await sleepAbortable(delayMs, signal);
			} catch {
				return finishAborted();
			}
		}
	})().catch((err) => {
		// unexpected throw from the driver loop itself: also end with a terminal error message (StreamFn contract), never a bare end()
		finishThrown(err instanceof Error ? err.message : String(err));
	});

	return out;
}
