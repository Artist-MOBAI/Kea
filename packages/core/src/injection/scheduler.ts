import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { wrapSystemReminder } from "../text.ts";

// single source moved to text.ts; re-exported here so existing import sites (kernel, package index) stay valid
export { wrapSystemReminder };

/**
 * Injection scheduler: unified channel for reminder-class injection.
 * - each reminder source (todo/plan/budget…) is a provider that manages its own throttle and dedupe state;
 * - delivery goes through the steer channel, wrapped in `<system-reminder>` (the system prompt declares this channel authoritative);
 * - compaction moves already-injected reminders out of context: after noteCompacted() each provider decides whether to replay.
 *
 * Stagnation/budget wrap-up are "turn-control steer" decided by TurnController and delivered in
 * shouldStopAfterTurn (not through here); this scheduler handles reminders collected at each turn end.
 */

export interface InjectionInput {
	/** whether this is the first collection of a new turn (after a user message) */
	isNewTurn: boolean;
	messages: readonly AgentMessage[];
}

export interface InjectionProvider {
	/** unique identifier (for dedupe and tests) */
	readonly variant: string;
	/** returns the body to inject (without wrapping tags); undefined = inject nothing this turn */
	evaluate(input: InjectionInput): string | undefined;
	/** called after compaction: persistent reminders can flag a replay here */
	onCompacted?(): void;
}

export class InjectionScheduler {
	private readonly providers: InjectionProvider[] = [];

	register(provider: InjectionProvider): void {
		this.providers.push(provider);
	}

	get size(): number {
		return this.providers.length;
	}

	/** Collect this turn's wrapped texts to inject (preserving registration order). */
	collect(input: InjectionInput): string[] {
		const out: string[] = [];
		for (const provider of this.providers) {
			const text = provider.evaluate(input);
			if (text !== undefined && text !== "") out.push(wrapSystemReminder(text));
		}
		return out;
	}

	/** Compaction happened: notify all providers (whether to replay is each provider's decision). */
	noteCompacted(): void {
		for (const provider of this.providers) provider.onCompacted?.();
	}
}
