import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { wrapSystemReminder } from "./text.ts";

export interface BudgetLimits {
	tokens?: number;
	usd?: number;
	iterations?: number;
	wallClockMs?: number;
	concurrentJobs?: number;
}

export type BudgetDimension = keyof BudgetLimits;

export interface BudgetCheck {
	exceeded: BudgetDimension;
	message: string;
}

export function aggregateUsage(messages: readonly AgentMessage[]): { tokens: number; usd: number } {
	let tokens = 0;
	let usd = 0;
	for (const message of messages) {
		// typeof guard for runtime safety: transcript data is not type-system-guaranteed, reading .role off a primitive would throw
		if (typeof message !== "object" || message === null || message.role !== "assistant") continue;
		const usage = message.usage;
		if (!usage) continue;
		tokens += usage.totalTokens ?? 0;
		usd += usage.cost?.total ?? 0;
	}
	return { tokens, usd };
}

export interface TurnSnapshot {
	turns: number;
	tokens: number;
	usd: number;
	promptStartedAt: number;
}

export class BudgetGuard {
	constructor(readonly limits: BudgetLimits) {}

	checkTurn(snapshot: TurnSnapshot): BudgetCheck | undefined {
		const { limits } = this;
		if (limits.iterations !== undefined && snapshot.turns >= limits.iterations) {
			return { exceeded: "iterations", message: `turn budget exhausted (${snapshot.turns}/${limits.iterations})` };
		}
		if (limits.tokens !== undefined && snapshot.tokens >= limits.tokens) {
			return { exceeded: "tokens", message: `token budget exhausted (${snapshot.tokens}/${limits.tokens})` };
		}
		if (limits.usd !== undefined && snapshot.usd >= limits.usd) {
			return { exceeded: "usd", message: `cost budget exhausted ($${snapshot.usd.toFixed(4)}/$${limits.usd})` };
		}
		if (limits.wallClockMs !== undefined && Date.now() - snapshot.promptStartedAt >= limits.wallClockMs) {
			return { exceeded: "wallClockMs", message: `wall-clock budget exhausted (${limits.wallClockMs}ms)` };
		}
		return undefined;
	}

	checkJobs(activeJobs: number): BudgetCheck | undefined {
		if (this.limits.concurrentJobs !== undefined && activeJobs >= this.limits.concurrentJobs) {
			return {
				exceeded: "concurrentJobs",
				message: `concurrent job budget exhausted (${activeJobs}/${this.limits.concurrentJobs} running)`,
			};
		}
		return undefined;
	}

	static wrapUpMessage(check: BudgetCheck): string {
		// two-tier budget notice: the first overrun injects this FINAL-turn steer; the second stops the run
		// outright — no second injection point exists, so this message already carries the hard form.
		const body = [
			`[budget] ${check.message}.`,
			`State: dimension=${check.exceeded}.`,
			"This is your FINAL turn: do NOT start new work and do NOT open new tool calls.",
			"Wrap up instead: summarize the current best result, persist anything durable (files, ledger entries), and state what remains undone.",
		].join("\n");
		return wrapSystemReminder(body);
	}
}
