import type { AgentMessage, Entry } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	adaptiveKeepRecentTokens,
	composeCompactionInstructions,
	isHarnessPromptMessage,
	isReminderOnlyMessage,
	RESEARCH_SUMMARY_INSTRUCTIONS,
	withSummaryGuard,
} from "../src/compaction.ts";
import { TRANSIENT_CONTINUE_TEXT } from "../src/retry.ts";

describe("composeCompactionInstructions", () => {
	test("no instruction returns the standard research summary rules unchanged", () => {
		expect(composeCompactionInstructions()).toBe(RESEARCH_SUMMARY_INSTRUCTIONS);
		expect(composeCompactionInstructions("")).toBe(RESEARCH_SUMMARY_INSTRUCTIONS);
	});

	test("custom instruction is prepended above the standard rules", () => {
		const custom = "Focus the summary on the crystallography evaluator.";
		const composed = composeCompactionInstructions(custom);
		expect(composed.startsWith(`${custom}\n\n`)).toBe(true);
		expect(composed.endsWith(RESEARCH_SUMMARY_INSTRUCTIONS)).toBe(true);
		// the standard rules must not be swallowed: negative results and numbers must still be required
		expect(composed).toContain("negative results prevent re-exploration");
	});

	test("anti-meta-comment guard: the handoff must not mention the compaction request or compaction itself", () => {
		// kimi compaction-instruction guard, Kea wording: the summary is the handoff, not a note about summarizing
		expect(RESEARCH_SUMMARY_INSTRUCTIONS).toContain(
			"no mention of this summarization request or of the context being compacted",
		);
	});
});

describe("adaptiveKeepRecentTokens (CJK density adaptation)", () => {
	const SETTINGS = { enabled: true, reserveTokens: 50_000, keepRecentTokens: 20_000 };
	const ASCII = "word ".repeat(4000); // ~20000 chars → pi ≈ 5000 tokens, real ≈ 5000 tokens
	// cjk-fixture: CJK session content for density-adaptive token budgeting
	const CJK = "测试数据".repeat(2000); // 8000 chars → pi ≈ 2000 tokens, real ≈ 8000 tokens (density 4x)

	function entry(text: string): Entry {
		return {
			type: "message",
			id: "e",
			seq: 0,
			parentId: null,
			timestamp: 0,
			message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
		} as unknown as Entry;
	}

	test("ASCII session: density ≈1, budget essentially unchanged (rounding tolerance)", () => {
		const keep = adaptiveKeepRecentTokens([entry(ASCII)], SETTINGS);
		expect(keep).toBeGreaterThanOrEqual(19_900);
		expect(keep).toBeLessThanOrEqual(20_000);
	});

	test("CJK session: pi underestimates 4x, budget shrinks 4x (≈5000) so the real tail stays within budget", () => {
		const keep = adaptiveKeepRecentTokens([entry(CJK)], SETTINGS);
		expect(keep).toBeGreaterThanOrEqual(4_900);
		expect(keep).toBeLessThanOrEqual(5_100);
	});

	test("empty entries: budget kept at its original value", () => {
		expect(adaptiveKeepRecentTokens([], SETTINGS)).toBe(20_000);
	});
});

describe("isReminderOnlyMessage (injections stay out of the compaction retained tail)", () => {
	const reminder = {
		role: "user",
		content: [{ type: "text", text: "<system-reminder>\nstate\n</system-reminder>" }],
		timestamp: 0,
	} as unknown as AgentMessage;
	const plain = {
		role: "user",
		content: [{ type: "text", text: "real user text" }],
		timestamp: 0,
	} as unknown as AgentMessage;

	test("user messages wrapped in system-reminder are recognized", () => {
		expect(isReminderOnlyMessage(reminder)).toBe(true);
	});

	test("plain user messages and assistant messages are not recognized", () => {
		expect(isReminderOnlyMessage(plain)).toBe(false);
		expect(isReminderOnlyMessage({ role: "assistant", content: [], timestamp: 0 } as unknown as AgentMessage)).toBe(
			false,
		);
	});

	test("wrapped messages with bare string content are also recognized", () => {
		expect(
			isReminderOnlyMessage({
				role: "user",
				content: "<system-reminder>x</system-reminder>",
				timestamp: 0,
			} as unknown as AgentMessage),
		).toBe(true);
	});
});

describe("isHarnessPromptMessage (harness round prompts stay out of the compaction retained tail)", () => {
	const roundPrompt = {
		role: "user",
		content: [{ type: "text", text: '<invention_round 3 phase="attack">\nobjective\n</invention_round>' }],
		timestamp: 0,
	} as unknown as AgentMessage;
	const reminder = {
		role: "user",
		content: [{ type: "text", text: "<system-reminder>\nstate\n</system-reminder>" }],
		timestamp: 0,
	} as unknown as AgentMessage;
	const plain = {
		role: "user",
		content: [{ type: "text", text: "real user text" }],
		timestamp: 0,
	} as unknown as AgentMessage;

	test("round prompts (invention/mobai round, recovery wording) are recognized as droppable", () => {
		expect(isHarnessPromptMessage(roundPrompt)).toBe(true);
		expect(
			isHarnessPromptMessage({
				role: "user",
				content: [{ type: "text", text: TRANSIENT_CONTINUE_TEXT }],
				timestamp: 0,
			} as unknown as AgentMessage),
		).toBe(true);
	});

	test("reminder channel and plain input are not recognized (channels are exclusive; plain input is preserved)", () => {
		expect(isHarnessPromptMessage(reminder)).toBe(false);
		expect(isHarnessPromptMessage(plain)).toBe(false);
	});
});

describe("withSummaryGuard (G9: provider failures can arrive as RESOLVED error messages)", () => {
	function summaryMessage(stopReason: "stop" | "error", errorMessage?: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: stopReason === "error" ? "" : "handoff summary" }],
			stopReason,
			errorMessage,
			timestamp: Date.now(),
		} as unknown as AssistantMessage;
	}

	function fakeModels(completeSimple: (options?: { signal?: AbortSignal }) => Promise<AssistantMessage>): Models {
		return {
			completeSimple: (_m: unknown, _c: unknown, options?: { signal?: AbortSignal }) => completeSimple(options),
		} as unknown as Models;
	}

	test("resolved retryable stopReason:error → same bounded backoff as the throw path, finally succeeds", async () => {
		let calls = 0;
		const guarded = withSummaryGuard(
			fakeModels(async () => {
				calls += 1;
				if (calls <= 2) return summaryMessage("error", "fetch failed: network error");
				return summaryMessage("stop");
			}),
			60_000,
		);
		const result = await guarded.completeSimple({} as never, {} as never);
		expect(calls).toBe(3);
		expect(result.stopReason).toBe("stop");
	}, 15_000);

	test("resolved non-retryable error (quota/auth) → returned as-is, no retry", async () => {
		let calls = 0;
		const guarded = withSummaryGuard(
			fakeModels(async () => {
				calls += 1;
				return summaryMessage("error", "invalid api key");
			}),
			60_000,
		);
		const result = await guarded.completeSimple({} as never, {} as never);
		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
	}, 10_000);

	test("retry budget exhausted → returns the last resolved error message (settlement left to the caller)", async () => {
		let calls = 0;
		const guarded = withSummaryGuard(
			fakeModels(async () => {
				calls += 1;
				return summaryMessage("error", "503 service unavailable");
			}),
			60_000,
		);
		const result = await guarded.completeSimple({} as never, {} as never);
		// SUMMARY_RETRIES = 2: attempts 0/1 retry, attempt 2 gives up and returns the message
		expect(calls).toBe(3);
		expect(result.stopReason).toBe("error");
	}, 15_000);

	test("wall clock fires → rejects and aborts underlying completion (merged signal, no dangling request)", async () => {
		let seenSignal: AbortSignal | undefined;
		const guarded = withSummaryGuard(
			fakeModels(
				(options) =>
					new Promise<AssistantMessage>((_resolve, reject) => {
						seenSignal = options?.signal;
						seenSignal?.addEventListener("abort", () => reject(new Error("underlying aborted")), { once: true });
					}),
			),
			50,
		);
		await expect(guarded.completeSimple({} as never, {} as never)).rejects.toThrow(
			/compaction summary request timed out/,
		);
		expect(seenSignal?.aborted).toBe(true);
	}, 10_000);

	test("caller's signal pre-aborted → rejects immediately, no request issued", async () => {
		let calls = 0;
		const guarded = withSummaryGuard(
			fakeModels(async () => {
				calls += 1;
				return summaryMessage("stop");
			}),
			60_000,
		);
		const aborted = AbortSignal.abort();
		await expect(guarded.completeSimple({} as never, {} as never, { signal: aborted })).rejects.toThrow(/aborted/);
		expect(calls).toBe(0);
	}, 10_000);
});
