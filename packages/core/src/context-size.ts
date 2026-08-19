import type { AgentMessage } from "@earendil-works/pi-agent-core";

// Current-context size estimation. The BASELINE is the real request usage of the last settled assistant message
// (provider-reported input incl. cache components + output — it already contains the system prompt and tool
// schemas). The heuristic estimate only covers messages appended SINCE that request, and is used wholesale while
// unanchored (fresh session, or after any transcript mutation until the next real request re-anchors). The
// heuristic is density-corrected: ASCII ≈ 4 chars/token, non-ASCII (CJK) ≈ 1 char/token — pi's plain chars/4
// underestimates CJK-heavy transcripts ~4x.

export const MEDIA_TOKEN_ESTIMATE = 2000;

// ASCII ≈ 4 chars/token, non-ASCII (CJK etc.) ≈ 1 char/token
export function estimateTextTokens(text: string): number {
	let ascii = 0;
	let nonAscii = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) <= 0x7f) ascii += 1;
		else nonAscii += 1;
	}
	return Math.ceil(ascii / 4) + nonAscii;
}

export function estimateToolsTokens(
	tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>,
): number {
	let total = 0;
	for (const tool of tools) {
		total += estimateTextTokens(`${tool.name}${tool.description ?? ""}${JSON.stringify(tool.parameters ?? {})}`);
	}
	return total;
}

// Per-message framing overhead (role tags, block headers — a few tokens per message).
const MESSAGE_OVERHEAD_TOKENS = 4;

// CJK-corrected per-message estimate: text blocks by density, structured blocks via their JSON serialization,
// images at the fixed estimate.
export function estimateMessageTokens(message: AgentMessage): number {
	if (typeof message !== "object" || message === null) return 0;
	let total = MESSAGE_OVERHEAD_TOKENS;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return total + estimateTextTokens(content);
	if (Array.isArray(content)) {
		for (const block of content) {
			if (typeof block === "string") {
				total += estimateTextTokens(block);
				continue;
			}
			if (typeof block === "object" && block !== null) {
				const b = block as { type?: string; text?: unknown };
				if (b.type === "text" && typeof b.text === "string") {
					total += estimateTextTokens(b.text);
					continue;
				}
				if (b.type === "image") {
					total += MEDIA_TOKEN_ESTIMATE;
					continue;
				}
				total += estimateTextTokens(JSON.stringify(block));
				continue;
			}
			total += estimateTextTokens(String(block));
		}
	}
	return total;
}

// Content-only estimate over a message list (density-corrected; excludes the request envelope).
export function estimateContextSize(messages: readonly AgentMessage[]): number {
	let total = 0;
	for (const message of messages) total += estimateMessageTokens(message);
	return total;
}

// Real request size from provider usage: every input component + output; `totalTokens` is only a fallback
// for providers that set it alone.
export function requestTokensOf(
	usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number } | undefined,
): number {
	if (!usage) return 0;
	const sum = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	if (sum > 0) return sum;
	return usage.totalTokens ?? 0;
}

// Kernel-owned context-size tracker: usage-anchored baseline + pending-delta estimate.
// - anchorUsage when an assistant message settles with real usage; invalidate on any transcript mutation
//   (compaction / session switch / fork): the anchor then refers to a pre-mutation request.
// - current(messages) = anchor + estimate(messages past the anchor point), or envelope + estimate(all)
//   while unanchored.
export class ContextSizeTracker {
	private anchorMessage: object | undefined;
	private anchorTokens = 0;
	private envelopeTokens = 0;

	// Request envelope (system prompt + tool schemas): added on top of the content estimate only while
	// UNANCHORED — the usage anchor already includes it.
	setEnvelope(
		systemPrompt: string,
		tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>,
	): void {
		this.envelopeTokens = estimateTextTokens(systemPrompt) + estimateToolsTokens(tools);
	}

	// The anchor is held BY MESSAGE IDENTITY: any transcript mutation that clones or replaces messages
	// (compaction, session switch, fork) makes the lookup fail and falls back to the estimate automatically —
	// invalidate() is belt-and-braces, not the only guard.
	anchorUsage(requestTokens: number, anchorMessage: object): void {
		if (requestTokens <= 0) return;
		this.anchorMessage = anchorMessage;
		this.anchorTokens = requestTokens;
	}

	// Transcript mutated: drop the (now stale) usage anchor until the next real request.
	invalidate(): void {
		this.anchorMessage = undefined;
	}

	get isAnchored(): boolean {
		return this.anchorMessage !== undefined;
	}

	current(messages: readonly AgentMessage[]): number {
		const anchor = this.anchorMessage;
		if (anchor === undefined) return this.envelopeTokens + estimateContextSize(messages);
		const idx = messages.indexOf(anchor as AgentMessage);
		if (idx === -1) return this.envelopeTokens + estimateContextSize(messages);
		return this.anchorTokens + estimateContextSize(messages.slice(idx + 1));
	}
}
