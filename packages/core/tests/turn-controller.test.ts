import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { BudgetGuard } from "../src/budget.ts";
import { COMPACTION_SETTINGS } from "../src/compaction.ts";
import { TurnController } from "../src/loop/turn-controller.ts";

const settings = { ...COMPACTION_SETTINGS, enabled: false };

describe("TurnController budget semantics (M1)", () => {
	test("first breach steers a wrap-up turn, second breach hard-stops", () => {
		const tc = new TurnController({ budget: new BudgetGuard({ iterations: 1 }), compactionSettings: settings });
		tc.resetPrompt();

		const first = tc.evaluateTurnEnd([]);
		expect(first.stop).toBe(false);
		expect(first.steerText).toContain("[budget]");
		expect(first.steerText).toContain("FINAL turn");

		const second = tc.evaluateTurnEnd([]);
		expect(second.stop).toBe(true);
		expect(second.steerText).toBeUndefined();
		expect(tc.budgetExhausted?.exceeded).toBe("iterations");
	});

	test("resetPrompt clears exhaustion and wrap-up state", () => {
		const tc = new TurnController({ budget: new BudgetGuard({ iterations: 1 }), compactionSettings: settings });
		tc.resetPrompt();
		tc.evaluateTurnEnd([]);
		tc.evaluateTurnEnd([]);
		tc.resetPrompt();
		expect(tc.budgetExhausted).toBeUndefined();
		const decision = tc.evaluateTurnEnd([]);
		expect(decision.stop).toBe(false);
		expect(decision.steerText).toContain("[budget]");
	});

	test("no budget guard → never stops", () => {
		const tc = new TurnController({ compactionSettings: settings });
		tc.resetPrompt();
		for (let i = 0; i < 50; i++) {
			expect(tc.evaluateTurnEnd([]).stop).toBe(false);
		}
	});
});

describe("TurnController stagnation (M1)", () => {
	test("three identical tool calls surface a stagnation reason", () => {
		const tc = new TurnController({ compactionSettings: settings });
		expect(tc.recordToolCall("bash", "{}", false)).toBeUndefined();
		expect(tc.recordToolCall("bash", "{}", false)).toBeUndefined();
		expect(tc.recordToolCall("bash", "{}", false)?.kind).toBe("repeated_call");
	});
});

describe("TurnController compaction trigger (M1)", () => {
	test("large context against a tiny window flags compaction and stops once", () => {
		const tc = new TurnController({ compactionSettings: { ...COMPACTION_SETTINGS, enabled: true }, contextWindow: 10 });
		tc.resetPrompt();
		const bigMessages: UserMessage[] = [
			{ role: "user", content: [{ type: "text", text: "x".repeat(10_000) }], timestamp: 1 },
		];
		const decision = tc.evaluateTurnEnd(bigMessages);
		expect(decision.stop).toBe(true);
		expect(tc.takeCompactionPending()).toBe(true);

		expect(tc.takeCompactionPending()).toBe(false);
	});
});

describe("TurnController restoreCompactionPending (returning the taken flag when the run chain breaks)", () => {
	test("restore after take allows another take; consumed flag is not re-armed", () => {
		const tc = new TurnController({ compactionSettings: { ...COMPACTION_SETTINGS, enabled: true }, contextWindow: 10 });
		tc.resetPrompt();
		const bigMessages: UserMessage[] = [
			{ role: "user", content: [{ type: "text", text: "x".repeat(10_000) }], timestamp: 1 },
		];
		expect(tc.evaluateTurnEnd(bigMessages).stop).toBe(true);

		expect(tc.takeCompactionPending()).toBe(true);
		tc.restoreCompactionPending();
		expect(tc.takeCompactionPending()).toBe(true);
		expect(tc.takeCompactionPending()).toBe(false);
	});
});

describe("TurnController cumulative usage is compaction-immune (regression: compaction refunds the budget)", () => {
	const assistant = (tokens: number, usd: number): AssistantMessage => ({
		role: "assistant",
		api: "test",
		provider: "test",
		model: "test",
		content: [],
		timestamp: 1,
		usage: {
			input: tokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd },
		},
		stopReason: "stop",
	});

	test("after compaction removes history messages, cumulative usage does not regress", () => {
		const tc = new TurnController({ compactionSettings: settings });
		tc.resetPrompt();

		const m1 = assistant(1000, 0.01);
		const m2 = assistant(2000, 0.02);
		tc.evaluateTurnEnd([m1]);
		tc.evaluateTurnEnd([m1, m2]);
		expect(tc.cumulativeUsage()).toEqual({ tokens: 3000, usd: 0.03 });

		const summary = assistant(50, 0.0005);
		const m3 = assistant(500, 0.005);
		tc.evaluateTurnEnd([summary, m3]);
		expect(tc.cumulativeUsage().tokens).toBeGreaterThanOrEqual(3000);
		expect(tc.cumulativeUsage().usd).toBeGreaterThanOrEqual(0.03);
	});

	test("the same message object seen repeatedly is not double-billed", () => {
		const tc = new TurnController({ compactionSettings: settings });
		tc.resetPrompt();
		const m1 = assistant(1000, 0.01);
		tc.evaluateTurnEnd([m1]);
		tc.evaluateTurnEnd([m1]);
		tc.evaluateTurnEnd([m1]);
		expect(tc.cumulativeUsage()).toEqual({ tokens: 1000, usd: 0.01 });
	});
});
