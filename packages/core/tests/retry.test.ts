import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	isContextOverflowError,
	isRetryableStreamError,
	retryBackoffDelayMs,
	runTurnWithTransientRetry,
	streamWithRetry,
	type TransientTurnHost,
	TurnDeadlineExceededError,
	withTurnDeadline,
} from "../src/retry.ts";

function finalMessage(over: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...over,
	};
}

function errorStream(errorMessage: string): AssistantMessageEventStream {
	const s = createAssistantMessageEventStream();
	const error = finalMessage({ stopReason: "error", errorMessage });
	s.push({ type: "error", reason: "error", error });
	s.end(error);
	return s;
}

function successStream(text: string): AssistantMessageEventStream {
	const s = createAssistantMessageEventStream();
	const partial = finalMessage({ content: [{ type: "text", text }] });
	s.push({ type: "start", partial });
	const done = finalMessage({ content: [{ type: "text", text }] });
	s.push({ type: "done", reason: "stop", message: done });
	s.end(done);
	return s;
}

describe("isRetryableStreamError (kimi error classification paradigm)", () => {
	test("network/timeout/overload errors are retryable", () => {
		expect(isRetryableStreamError("Connection error.")).toBe(true);
		expect(isRetryableStreamError("fetch failed")).toBe(true);
		expect(isRetryableStreamError("request timed out")).toBe(true);
		expect(isRetryableStreamError("529")).toBe(true);
		expect(isRetryableStreamError("HTTP 429 rate limit")).toBe(true);
		expect(isRetryableStreamError("503 overloaded")).toBe(true);
	});

	test("auth/quota errors are not retryable", () => {
		expect(isRetryableStreamError("401 Unauthorized")).toBe(false);
		expect(isRetryableStreamError("invalid api key")).toBe(false);
		expect(isRetryableStreamError("quota exceeded")).toBe(false);
		expect(isRetryableStreamError("some other failure")).toBe(false);
	});
});

describe("retryBackoffDelayMs (exponential backoff)", () => {
	test("starts at 500ms, ×2 growth, 32s cap, +25% jitter", () => {
		const d0 = Array.from({ length: 50 }, () => retryBackoffDelayMs(0));
		expect(Math.min(...d0)).toBeGreaterThanOrEqual(500);
		expect(Math.max(...d0)).toBeLessThanOrEqual(625);
		const d3 = Array.from({ length: 50 }, () => retryBackoffDelayMs(3));
		expect(Math.min(...d3)).toBeGreaterThanOrEqual(4000);
		const d10 = Array.from({ length: 50 }, () => retryBackoffDelayMs(10));
		expect(Math.max(...d10)).toBeLessThanOrEqual(40_000);
	});
});

describe("streamWithRetry (stream-level retry)", () => {
	test("retries automatically after a connection error and succeeds", async () => {
		let calls = 0;
		const retries: number[] = [];
		const out = streamWithRetry(
			() => {
				calls += 1;
				return calls === 1 ? errorStream("Connection error.") : successStream("hello");
			},
			{
				maxAttempts: 3,
				onRetry: (info) => retries.push(info.attempt),
			},
		);
		const events: string[] = [];
		let finalText = "";
		for await (const event of out) {
			events.push(event.type);
			if (event.type === "done") finalText = (event.message.content[0] as { text?: string }).text ?? "";
		}
		expect(calls).toBe(2);
		expect(retries).toEqual([1]);
		expect(events).toContain("start");
		expect(events).toContain("done");
		expect(events).not.toContain("error");
		expect(finalText).toBe("hello");
	}, 10_000);

	test("no retry after content produced; start frame is not content — a drop after start still retries", async () => {
		let calls = 0;
		const out = streamWithRetry(
			() => {
				calls += 1;
				const s = createAssistantMessageEventStream();
				const partial = finalMessage({ content: [{ type: "text", text: "partial" }] });
				s.push({ type: "start", partial });
				if (calls === 1) {
					// first attempt: only the start frame (no delta) — content has NOT been produced, retry is safe
					const error = finalMessage({ stopReason: "error", errorMessage: "Connection error." });
					s.push({ type: "error", reason: "error", error });
					s.end(error);
					return s;
				}
				// second attempt: a real text delta is content — a drop after it must NOT retry the stream
				s.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
				const error = finalMessage({ stopReason: "error", errorMessage: "Connection error." });
				s.push({ type: "error", reason: "error", error });
				s.end(error);
				return s;
			},
			{ maxAttempts: 3 },
		);
		const events: string[] = [];
		for await (const event of out) events.push(event.type);
		expect(calls).toBe(2);
		// the empty start frame of the failed attempt IS forwarded (no content in it) — only CONTENT
		// must never duplicate across retries
		expect(events).toEqual(["start", "start", "text_delta", "error"]);
	}, 10_000);

	test("auth errors are not retried", async () => {
		let calls = 0;
		const out = streamWithRetry(
			() => {
				calls += 1;
				return errorStream("401 Unauthorized");
			},
			{ maxAttempts: 3 },
		);
		const events: string[] = [];
		for await (const event of out) events.push(event.type);
		expect(calls).toBe(1);
		expect(events).toEqual(["error"]);
	}, 10_000);

	test("ends with an error event after retries are exhausted", async () => {
		let calls = 0;
		const out = streamWithRetry(
			() => {
				calls += 1;
				return errorStream("Connection error.");
			},
			{ maxAttempts: 2 },
		);
		const events: string[] = [];
		let lastError = "";
		for await (const event of out) {
			events.push(event.type);
			if (event.type === "error") lastError = event.error.errorMessage ?? "";
		}
		expect(calls).toBe(2);
		expect(events).toEqual(["error"]);
		expect(lastError).toBe("Connection error.");
	}, 15_000);

	test("thrown errors become an error event with the message preserved", async () => {
		const out = streamWithRetry(
			() => {
				throw new Error("fetch failed");
			},
			{
				maxAttempts: 1,
				makeErrorMessage: (msg) => finalMessage({ stopReason: "error", errorMessage: msg }),
			},
		);
		let got: string | undefined;
		for await (const event of out) {
			if (event.type === "error") got = event.error.errorMessage;
		}
		expect(got).toBe("fetch failed");
	}, 10_000);

	test("abort before the first attempt → terminal aborted message (StreamFn contract)", async () => {
		const controller = new AbortController();
		controller.abort(new Error("user aborted"));
		const out = streamWithRetry(() => successStream("never"), {
			maxAttempts: 3,
			signal: controller.signal,
			makeErrorMessage: (msg) => finalMessage({ stopReason: "error", errorMessage: msg }),
		});
		const events: string[] = [];
		let terminal: AssistantMessage | undefined;
		for await (const event of out) {
			events.push(event.type);
			if (event.type === "error") {
				expect(event.reason).toBe("aborted");
				terminal = event.error;
			}
		}
		expect(events).toEqual(["error"]);
		expect(terminal?.stopReason).toBe("aborted");
		expect(await out.result()).toBe(terminal);
	}, 10_000);

	test("abort during backoff wait → terminal aborted message (no bare end)", async () => {
		const controller = new AbortController();
		let calls = 0;
		const out = streamWithRetry(
			() => {
				calls += 1;
				return errorStream("Connection error.");
			},
			{
				maxAttempts: 5,
				signal: controller.signal,
				// onRetry fires before the backoff sleep: abort now and sleepAbortable rejects immediately
				onRetry: () => controller.abort(),
				makeErrorMessage: (msg) => finalMessage({ stopReason: "error", errorMessage: msg }),
			},
		);
		const events: string[] = [];
		let terminal: AssistantMessage | undefined;
		for await (const event of out) {
			events.push(event.type);
			if (event.type === "error") {
				expect(event.reason).toBe("aborted");
				terminal = event.error;
			}
		}
		expect(calls).toBe(1);
		expect(events).toEqual(["error"]);
		expect(terminal?.stopReason).toBe("aborted");
		expect(await out.result()).toBe(terminal);
	}, 10_000);

	test("idle watchdog: hang with no events → timeout error → retry succeeds (real: silent socket hang)", async () => {
		let calls = 0;
		const out = streamWithRetry(
			() => {
				calls += 1;
				if (calls === 1) {
					// a stream that neither produces events nor errors — the silent-hang failure mode
					return createAssistantMessageEventStream();
				}
				return successStream("recovered");
			},
			{ maxAttempts: 3, idleTimeoutMs: 50 },
		);
		const events: string[] = [];
		let finalText = "";
		for await (const event of out) {
			events.push(event.type);
			if (event.type === "done") finalText = (event.message.content[0] as { text?: string }).text ?? "";
		}
		expect(calls).toBe(2);
		expect(events).toContain("done");
		expect(finalText).toBe("recovered");
	}, 10_000);

	test("idle watchdog: hang after content → timeout ends as terminal error (no retry, no duplication)", async () => {
		let calls = 0;
		const out = streamWithRetry(
			() => {
				calls += 1;
				const s = createAssistantMessageEventStream();
				const partial = finalMessage({ content: [{ type: "text", text: "partial" }] });
				s.push({ type: "start", partial });
				// a real delta marks content: an idle timeout after it must terminal-error, not re-issue the stream
				s.push({ type: "text_delta", contentIndex: 0, delta: "p", partial });
				return s;
			},
			{ maxAttempts: 3, idleTimeoutMs: 50 },
		);
		const events: string[] = [];
		let errorMessage = "";
		for await (const event of out) {
			events.push(event.type);
			if (event.type === "error") errorMessage = event.error.errorMessage ?? "";
		}
		expect(calls).toBe(1);
		expect(events).toEqual(["start", "text_delta", "error"]);
		expect(errorMessage).toContain("stream idle timeout");
		// the synthesized error must be retry-classified so turn-level continuation picks it up
		expect(isRetryableStreamError(errorMessage)).toBe(true);
	}, 10_000);
});

describe("runTurnWithTransientRetry (turn-level transient retry: mid-stream drop continuation)", () => {
	function host(script: (string | undefined)[], prompts: string[]): TransientTurnHost {
		return {
			async prompt(text) {
				prompts.push(text);
			},
			async waitForIdle() {},
			errorMessage() {
				return script.shift();
			},
		};
	}

	test("one mid-stream drop → continuation succeeds on the second attempt", async () => {
		const prompts: string[] = [];
		const h = host(["The socket connection was closed unexpectedly", undefined], prompts);
		const out = await runTurnWithTransientRetry(h, "task", { backoffMs: 1 });
		expect(out.error).toBeUndefined();
		expect(out.attempts).toBe(2);
		expect(prompts).toEqual(["task", expect.stringContaining("continue")]);
	});

	test("non-retryable errors (auth/quota) → return immediately, no continuation", async () => {
		const prompts: string[] = [];
		const h = host(["invalid api key (401)"], prompts);
		const out = await runTurnWithTransientRetry(h, "task", { backoffMs: 1 });
		expect(out.error).toContain("invalid api key");
		expect(out.attempts).toBe(1);
		expect(prompts).toEqual(["task"]);
	});

	test("consecutive transient errors to the cap → error returned, attempts capped", async () => {
		const prompts: string[] = [];
		const h = host(
			Array.from({ length: 10 }, () => "The socket connection was closed unexpectedly"),
			prompts,
		);
		const out = await runTurnWithTransientRetry(h, "task", { maxAttempts: 3, backoffMs: 1 });
		expect(out.error).toContain("socket");
		expect(out.attempts).toBe(3);
		expect(prompts.length).toBe(3);
	});
});

describe("withTurnDeadline (in-turn wall-clock watchdog)", () => {
	test("deadline not reached → passes the result through unchanged, no abort", async () => {
		let aborted = 0;
		const value = await withTurnDeadline(Promise.resolve("ok"), Date.now() + 60_000, () => {
			aborted++;
		});
		expect(value).toBe("ok");
		expect(aborted).toBe(0);
	});

	test("deadline already passed → aborts immediately and throws TurnDeadlineExceededError", async () => {
		let aborted = 0;
		await expect(
			withTurnDeadline(new Promise(() => {}), Date.now() - 1, () => {
				aborted++;
			}),
		).rejects.toBeInstanceOf(TurnDeadlineExceededError);
		expect(aborted).toBe(1);
	});

	test("deadline hit mid-turn → timer aborts and rejects (race semantics)", async () => {
		let aborted = 0;
		await expect(
			withTurnDeadline(new Promise(() => {}), Date.now() + 30, () => {
				aborted++;
			}),
		).rejects.toBeInstanceOf(TurnDeadlineExceededError);
		expect(aborted).toBe(1);
	});

	test("unbounded budget → passthrough, no abort (audit: setTimeout(fn, Infinity) fires in 1ms)", async () => {
		let aborted = 0;
		// a turn that resolves slowly must NOT be raced to a 1ms coerced timer
		const value = await withTurnDeadline(
			new Promise((resolve) => setTimeout(() => resolve("unbounded-ok"), 80)),
			Number.POSITIVE_INFINITY,
			() => {
				aborted++;
			},
		);
		expect(value).toBe("unbounded-ok");
		expect(aborted).toBe(0);
	}, 10_000);
});

describe("isContextOverflowError (extended phrasing set)", () => {
	test("recognizes the context_length_exceeded code form", () => {
		expect(isContextOverflowError("400 Bad Request: context_length_exceeded")).toBe(true);
	});
	test("recognizes the 'input exceeds' variant", () => {
		expect(isContextOverflowError("Input for this request exceeds the maximum limit allowed.")).toBe(true);
	});
	test("recognizes the 'token limit exceeded' variant", () => {
		expect(isContextOverflowError("The token limit was exceeded for the request.")).toBe(true);
	});
	test("ordinary errors are not misdetected", () => {
		expect(isContextOverflowError("Connection refused")).toBe(false);
		expect(isContextOverflowError("input file exceeds expectations")).toBe(false);
	});
});
