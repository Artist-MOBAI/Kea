import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import { COMPACTION_SETTINGS, COMPACTION_TRIGGER_RATIO, contextNeedsCompaction } from "../src/compaction.ts";
import {
	ContextSizeTracker,
	estimateContextSize,
	estimateTextTokens,
	estimateToolsTokens,
	requestTokensOf,
} from "../src/context-size.ts";
import { isContextOverflowError } from "../src/retry.ts";

function assistantWithUsage(text: string, inputTokens: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: inputTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

describe("density heuristic (kimi tokens.ts alignment)", () => {
	test("ASCII ≈ 4 chars/token, non-ASCII (CJK) ≈ 1 char/token", () => {
		expect(estimateTextTokens("abcdefgh")).toBe(2);
		// cjk-fixture: exercises CJK density estimation (chars/4 would underestimate 4x)
		expect(estimateTextTokens("中文四个字")).toBe(5); // 5 CJK → 5 (chars/4 would say 2)
		// the production failure mode: a CJK-heavy transcript is no longer underestimated 4x
		expect(estimateTextTokens("中".repeat(4000))).toBe(4000);
	});

	test("estimateContextSize estimates from content, ignoring stale per-request usage (unanchored path)", () => {
		const stale = assistantWithUsage("done", 986_900);
		const summary = user("[Previous context summary]\n…the handoff note…");
		const size = estimateContextSize([summary, stale]);
		expect(size).toBeLessThan(5_000); // content-based, NOT ~986.9k
		expect(size).toBeGreaterThan(0);
	});

	test("requestTokensOf sums all input components + output", () => {
		expect(requestTokensOf({ input: 100, output: 5, cacheRead: 50, cacheWrite: 20 })).toBe(175);
		expect(requestTokensOf(undefined)).toBe(0);
		expect(requestTokensOf({ totalTokens: 42 })).toBe(42); // fallback
	});

	test("tool schemas count toward the envelope", () => {
		const tokens = estimateToolsTokens([
			{ name: "check_goal", description: "Machine-evaluate every mobai criterion.", parameters: { type: "object" } },
		]);
		expect(tokens).toBeGreaterThan(10);
	});
});

describe("ContextSizeTracker (usage anchoring + pending delta)", () => {
	test("after anchoring: baseline = real request usage, estimation only adds post-anchor messages", () => {
		const tracker = new ContextSizeTracker();
		tracker.setEnvelope("system prompt", [{ name: "t", description: "d", parameters: {} }]);
		const anchor = assistantWithUsage("done", 800_000);
		const messages: AgentMessage[] = [user("q"), anchor];
		tracker.anchorUsage(requestTokensOf((anchor as { usage?: never }).usage), anchor);
		messages.push(user("hello world"));
		const size = tracker.current(messages);
		expect(size).toBeGreaterThanOrEqual(800_000);
		expect(size).toBeLessThan(810_000); // anchor + small pending delta — NOT content re-estimate
	});

	test("unanchored: envelope + content estimate", () => {
		const tracker = new ContextSizeTracker();
		tracker.setEnvelope("system prompt text", []);
		const size = tracker.current([user("hi there")]);
		const envelopeAlone = tracker.current([]);
		expect(envelopeAlone).toBeGreaterThan(0);
		expect(size).toBeGreaterThan(envelopeAlone);
	});

	test("anchor cloned/replaced (compaction) → falls back to content estimation; invalidate forces it", () => {
		const tracker = new ContextSizeTracker();
		const anchor = assistantWithUsage("done", 986_900);
		tracker.anchorUsage(986_900, anchor);
		// compaction clones the retained tail: identity lookup fails → envelope + content estimate
		const cloned: AgentMessage[] = [
			user("[summary]"),
			{ ...anchor, content: [{ type: "text", text: "done" }] } as AgentMessage,
		];
		expect(tracker.current(cloned)).toBeLessThan(5_000);
		tracker.anchorUsage(500_000, anchor);
		tracker.invalidate();
		expect(tracker.isAnchored).toBe(false);
	});
});

describe("compaction trigger (kimi dual condition)", () => {
	test("85% threshold fires; below neither condition fires", () => {
		expect(contextNeedsCompaction(Math.floor(200_000 * COMPACTION_TRIGGER_RATIO), 200_000)).toBe(true);
		// 140k = 70% (<85%) and 140k + 50k reserve = 190k (<200k): neither condition fires
		expect(contextNeedsCompaction(140_000, 200_000)).toBe(false);
	});

	test("reserve is clamped: small windows at low usage no longer spin re-compaction (G9)", () => {
		// 160k of 200k is 80% (<85%): with the reserve clamped to 15% of the window (30k), 160k + 30k < 200k —
		// the unclamped 50k reserve made this fire and would fire again on every pruned transcript below 150k
		expect(contextNeedsCompaction(160_000, 200_000, COMPACTION_SETTINGS)).toBe(false);
		// small custom window (≤ reserveTokens): the reserve arm used to be trivially true at ANY usage
		expect(contextNeedsCompaction(1_000, 40_000, COMPACTION_SETTINGS)).toBe(false);
		// ≥85%-style usage stays the real trigger
		expect(contextNeedsCompaction(35_000, 40_000, COMPACTION_SETTINGS)).toBe(true);
	});

	test("pruned transcript no longer triggers (prevents infinite re-compaction)", () => {
		const prunedTokens = estimateContextSize([
			user("[Previous context summary]\nhandoff"),
			assistantWithUsage("done", 986_900),
		]);
		expect(contextNeedsCompaction(prunedTokens, 200_000, COMPACTION_SETTINGS)).toBe(false);
	});
});

describe("context overflow detection (kimi kosong alignment)", () => {
	test("matches the real DeepSeek 400 body and other vendors' wording", () => {
		const deepseek400 =
			'{"message":"This model\'s maximum context length is 1048576 tokens. However, you requested 1050492 tokens (1050491 in the messages, 1 in the completion). Please reduce the length of the messages or completion.","type":"invalid_request_error"}';
		expect(isContextOverflowError(deepseek400)).toBe(true);
		expect(isContextOverflowError("prompt is too long: maximum context length exceeded")).toBe(true);
		expect(isContextOverflowError("context_length_exceeded")).toBe(true);
		// a 413 with token/context wording IS context overflow — treating it as generic wedges the session
		expect(isContextOverflowError("Error 413: request too large — input tokens exceed limit")).toBe(true);
		// genuinely generic 413 (payload too large with no token/context wording) stays non-overflow
		expect(isContextOverflowError("Error 413: request too large")).toBe(false);
	});

	test("ordinary network/quota errors are not misdetected", () => {
		expect(isContextOverflowError("fetch failed: econnrefused")).toBe(false);
		expect(isContextOverflowError("429 Your token-plan quota has been exhausted")).toBe(false);
	});
});
