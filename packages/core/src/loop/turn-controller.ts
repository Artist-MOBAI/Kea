import type { AgentMessage, CompactionSettings } from "@earendil-works/pi-agent-core";
import { aggregateUsage, type BudgetCheck, BudgetGuard } from "../budget.ts";
import { contextNeedsCompaction } from "../compaction.ts";
import { estimateContextSize } from "../context-size.ts";
import { createStagnationGuard, type StagnationReason } from "./stagnation.ts";

export interface TurnDecision {
	stop: boolean;

	steerText?: string;
}

export interface TurnControllerOptions {
	budget?: BudgetGuard;
	compactionSettings: CompactionSettings;
	contextWindow?: number;
	stagnationThreshold?: number;
	/**
	 * Context-size metric for the compaction trigger: the kernel passes its usage-anchored tracker so
	 * the trigger sees the real request size including the envelope (system prompt + tool schemas).
	 * Defaults to the density-corrected content estimate.
	 */
	contextTokens?: (messages: readonly AgentMessage[]) => number;
}

export class TurnController {
	private turnsThisPrompt = 0;
	private wrapUpQueued = false;
	private promptStartedAt = Date.now();
	private compactionPending = false;
	private exhausted: BudgetCheck | undefined;
	private readonly stagnation: ReturnType<typeof createStagnationGuard>;
	/**
	 * Monotonically accumulated usage: compaction replaces history with a summary, so re-deriving from surviving messages
	 * each time would "refund" budget on every compaction. Accumulate incrementally by message object identity (WeakSet: messages removed by compaction can be GC'd).
	 */
	private readonly countedMessages = new WeakSet<object>();
	private cumulativeTokens = 0;
	private cumulativeUsd = 0;

	constructor(private readonly options: TurnControllerOptions) {
		this.stagnation = createStagnationGuard(
			options.stagnationThreshold !== undefined ? { threshold: options.stagnationThreshold } : {},
		);
	}

	resetPrompt(): void {
		this.turnsThisPrompt = 0;
		this.wrapUpQueued = false;
		this.promptStartedAt = Date.now();
		this.exhausted = undefined;
		this.stagnation.reset();
	}

	evaluateTurnEnd(messages: readonly AgentMessage[]): TurnDecision {
		// account for the just-ended turn's usage and turn count first: no later decision (compact/stop) may swallow it
		this.accumulateUsage(messages);
		this.turnsThisPrompt += 1;

		if (
			!this.compactionPending &&
			contextNeedsCompaction(
				this.options.contextTokens?.(messages) ?? estimateContextSize(messages),
				this.options.contextWindow,
				this.options.compactionSettings,
			)
		) {
			this.compactionPending = true;
			return { stop: true };
		}

		const guard = this.options.budget;
		if (!guard) return { stop: false };

		const check = guard.checkTurn({
			turns: this.turnsThisPrompt,
			tokens: this.cumulativeTokens,
			usd: this.cumulativeUsd,
			promptStartedAt: this.promptStartedAt,
		});
		if (!check) return { stop: false };

		this.exhausted = check;
		if (!this.wrapUpQueued) {
			this.wrapUpQueued = true;
			return { stop: false, steerText: BudgetGuard.wrapUpMessage(check) };
		}
		return { stop: true };
	}

	recordToolCall(toolName: string, argsKey: string, isError: boolean): StagnationReason | undefined {
		return this.stagnation.record(toolName, argsKey, isError);
	}

	/** Incremental accumulation: count only new, not-yet-counted messages; compaction replacing history does not affect already-accumulated values. */
	private accumulateUsage(messages: readonly AgentMessage[]): void {
		// typeof guard for runtime safety: WeakSet.has throws on primitives, and transcript data is not type-system-guaranteed
		const fresh = messages.filter((m) => typeof m === "object" && m !== null && !this.countedMessages.has(m));
		for (const m of fresh) this.countedMessages.add(m);
		const usage = aggregateUsage(fresh);
		this.cumulativeTokens += usage.tokens;
		this.cumulativeUsd += usage.usd;
	}

	/** Cumulative usage since kernel start (compaction-immune), shown by /usage etc. */
	cumulativeUsage(): { tokens: number; usd: number } {
		return { tokens: this.cumulativeTokens, usd: this.cumulativeUsd };
	}

	/** Called after compaction rewrites the transcript: mark the newly cloned retained-tail messages as counted, so the next turn does not double-count them by object identity. */
	rebaseAfterCompaction(messages: readonly AgentMessage[]): void {
		for (const m of messages) {
			if (typeof m === "object" && m !== null) this.countedMessages.add(m);
		}
	}

	takeCompactionPending(): boolean {
		const pending = this.compactionPending;
		this.compactionPending = false;
		return pending;
	}

	/** Session-switch only: unconditionally clear the previous session's leftover compaction pending (not resetPrompt, which would clear the tail-chain restore's legitimate re-trigger). */
	clearCompactionPending(): void {
		this.compactionPending = false;
	}

	/** Return a compaction pending: called when the chain breaks after take (compaction failure/session switch/attempts exhausted), so the next prompt re-triggers compaction. */
	restoreCompactionPending(): void {
		this.compactionPending = true;
	}

	updateContextWindow(contextWindow: number | undefined): void {
		this.options.contextWindow = contextWindow;
	}

	get budgetExhausted(): BudgetCheck | undefined {
		return this.exhausted;
	}
}
