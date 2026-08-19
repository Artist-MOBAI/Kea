import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";
import {
	FORMALIZE_PROMPT_PREFIX,
	isHarnessPromptText,
	isSystemReminderText,
	MOBAI_RESUME_PROMPT_PREFIX,
	OVERFLOW_CONTINUE_TEXT,
	SYSTEM_REMINDER_OPEN,
	TRANSIENT_CONTINUE_TEXT,
	UNTRUSTED_OBJECTIVE_CLOSE,
	UNTRUSTED_OBJECTIVE_OPEN,
	unescapeUntrustedText,
} from "@kea/core";
import type { ThemeStyles } from "../theme.ts";
import { AssistantMessageView } from "./messages/assistant-message.ts";
import { RoundSection } from "./messages/round-section.ts";
import type { SectionToolPart } from "./messages/section-card.ts";
import { StatusMessage } from "./messages/status-message.ts";
import { ToolCallView } from "./messages/tool-call.ts";

interface TranscriptDeps {
	styles: ThemeStyles;
	markdownTheme: MarkdownTheme;
	cwd: string;
	isExpanded: () => boolean;
	requestRender: () => void;
}

interface AssistantText {
	kind: "text";
	text: string;
}
interface AssistantCall {
	kind: "call";
	id: string;
	name: string;
	args: unknown;
}

/**
 * First meaningful line inside a `<system-reminder>` wrapper ("" when absent): the compact headline the
 * replay path shows instead of a user bubble.
 */
export function systemReminderHeadline(text: string): string {
	const open = text.indexOf(SYSTEM_REMINDER_OPEN);
	if (open === -1) return "";
	const body = text.slice(open + SYSTEM_REMINDER_OPEN.length);
	const close = body.indexOf("</system-reminder>");
	const scoped = close !== -1 ? body.slice(0, close) : body;
	return (
		scoped
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l !== "") ?? ""
	);
}

function extractUntrustedObjective(text: string): string | undefined {
	const open = text.indexOf(UNTRUSTED_OBJECTIVE_OPEN);
	if (open === -1) return undefined;
	const body = text.slice(open + UNTRUSTED_OBJECTIVE_OPEN.length);
	const close = body.indexOf(UNTRUSTED_OBJECTIVE_CLOSE);
	if (close === -1) return undefined;
	return unescapeUntrustedText(body.slice(0, close).trim());
}

function firstLineTruncated(text: string, limit = 60): string {
	const firstLine =
		text
			.split("\n")
			.find((l) => l.trim() !== "")
			?.trim() ?? "";
	if (firstLine.length <= limit) return firstLine;
	const slice = firstLine.slice(0, limit);
	const boundary = slice.lastIndexOf(" ");
	return `${(boundary > 0 ? slice.slice(0, boundary) : slice).trimEnd()}…`;
}

export type HarnessPromptDisplay = { kind: "userEcho"; text: string } | { kind: "status"; label: string };

/**
 * Display classification for a harness round prompt, shared by live continuation headers and replay:
 * prompts that originated as a user-typed command (formalization, /mobai resume) come back as the
 * reconstructed command line (userEcho); everything else maps to a compact dim status label.
 * undefined = not a harness prompt (callers fall back to their own path).
 */
export function harnessPromptDisplay(text: string): HarnessPromptDisplay | undefined {
	const stripped = text.trimStart();
	if (stripped.startsWith(FORMALIZE_PROMPT_PREFIX)) {
		const objective = extractUntrustedObjective(stripped);
		// No objective block (template drift): degrade to a status label, never a wrong command line.
		return objective === undefined
			? { kind: "status", label: "program formalization" }
			: { kind: "userEcho", text: `/mobai ${objective}` };
	}
	if (stripped.startsWith(MOBAI_RESUME_PROMPT_PREFIX)) return { kind: "userEcho", text: "/mobai resume" };
	if (stripped === TRANSIENT_CONTINUE_TEXT) return { kind: "status", label: "network interruption — resuming" };
	if (stripped === OVERFLOW_CONTINUE_TEXT) return { kind: "status", label: "context overflow — resuming" };
	const invention = stripped.match(/^<invention_round (\d+)(?:\/\d+)? phase="([^"]+)">/);
	if (invention) return { kind: "status", label: `program round ${invention[1]} — ${invention[2]}` };
	if (stripped.startsWith("<goal_round")) {
		const round = stripped.match(/^Round: (\d+)$/m);
		return { kind: "status", label: round ? `mobai round ${round[1]}` : "mobai round" };
	}
	if (stripped.startsWith("<program_round")) return { kind: "status", label: "program round" };
	return undefined;
}

export function harnessPromptDisplayLabel(text: string): string {
	const display = harnessPromptDisplay(text);
	if (display === undefined) return firstLineTruncated(text.trimStart());
	return display.kind === "userEcho" ? display.text : display.label;
}

export function harnessPromptHeadline(text: string): string {
	return harnessPromptDisplayLabel(text);
}

export function renderTranscript(messages: AgentMessage[], deps: TranscriptDeps): Component[] {
	const results = collectToolResults(messages);
	const components: Component[] = [];

	let section: RoundSection | undefined;
	// An orphan half-turn's section mounts lazily — pushed only once its first child lands, so
	// content-less messages never produce an empty card + stray caption.
	let sectionMounted = false;
	let agentParts: SectionToolPart[] = [];
	let turnFailed = false;
	let turnStart = 0;
	let lastTs = 0;

	const closeSection = (): void => {
		if (section?.hasContent) section.finish(agentParts, Math.max(0, lastTs - turnStart), turnFailed);
		section = undefined;
		sectionMounted = false;
		agentParts = [];
		turnFailed = false;
	};

	const mountSection = (): void => {
		if (!section || sectionMounted) return;
		components.push(section, section.caption);
		sectionMounted = true;
	};

	for (const message of messages) {
		if (!("role" in message)) continue;
		if (typeof message.timestamp === "number") lastTs = message.timestamp;

		if (message.role === "user") {
			closeSection();
			const text = userTextOf(message);
			if (text.trim() === "") continue;
			// Reminder-channel injections are lifecycle plumbing, never a user bubble — show a dim status line.
			if (isSystemReminderText(text)) {
				components.push(new StatusMessage(`· ${systemReminderHeadline(text)}`, deps.styles, "dim"));
				continue;
			}
			// Harness prompts render as a dim status line — except command-originated ones, which
			// reconstruct the typed command line and replay as a normal user bubble.
			if (isHarnessPromptText(text)) {
				const display = harnessPromptDisplay(text);
				if (display?.kind === "userEcho") {
					section = new RoundSection(deps.styles);
					section.appendUser({
						role: "user",
						content: [{ type: "text", text: display.text }],
						timestamp: message.timestamp,
					} as never);
					components.push(section, section.caption);
					sectionMounted = true;
					turnStart = typeof message.timestamp === "number" ? message.timestamp : lastTs;
					continue;
				}
				components.push(new StatusMessage(`· ${display?.label ?? harnessPromptHeadline(text)}`, deps.styles, "dim"));
				continue;
			}
			section = new RoundSection(deps.styles);
			section.appendUser(message);
			components.push(section, section.caption);
			sectionMounted = true;
			turnStart = typeof message.timestamp === "number" ? message.timestamp : lastTs;
			continue;
		}

		if (message.role === "toolResult") {
			// Replay has no live state: color the turn's frame directly by result.
			if ((message as { isError?: unknown }).isError === true) turnFailed = true;
			continue;
		}

		if (message.role === "assistant" && Array.isArray(message.content)) {
			const stopReason = (message as { stopReason?: unknown }).stopReason;
			if (stopReason === "error" || stopReason === "aborted") turnFailed = true;
			if (!section) {
				// A resumed half-turn becomes its own section; mounting stays deferred until the first child lands.
				section = new RoundSection(deps.styles);
				turnStart = lastTs;
			}
			const parts: Array<AssistantText | AssistantCall> = [];
			for (const block of message.content) {
				if (typeof block !== "object" || block === null) continue;
				if (block.type === "text" && "text" in block && typeof block.text === "string" && block.text !== "") {
					parts.push({ kind: "text", text: block.text });
				} else if (block.type === "toolCall" && "id" in block && "name" in block) {
					parts.push({
						kind: "call",
						id: String((block as { id: unknown }).id),
						name: String((block as { name: unknown }).name),
						args: (block as { arguments?: unknown }).arguments,
					});
				}
			}
			const thinkingText = message.content
				.filter(
					(b): b is { type: "thinking"; thinking: string } =>
						typeof b === "object" && b !== null && b.type === "thinking",
				)
				.map((b) => b.thinking)
				.join("");
			let thinkingAttached = false;
			for (const part of parts) {
				if (part.kind === "text") {
					const view = new AssistantMessageView(message, deps.markdownTheme, deps.styles, deps.isExpanded);
					view.update(part.text);
					view.finalize(part.text);
					if (thinkingText !== "" && !thinkingAttached) {
						view.thinking.setText(thinkingText);
						view.thinking.finalize();
						thinkingAttached = true;
					}
					mountSection();
					section.addAgentChild(view);
					continue;
				}
				const view = new ToolCallView({
					name: part.name,
					args: part.args,
					cwd: deps.cwd,
					styles: deps.styles,
					isExpanded: deps.isExpanded,
					requestRender: deps.requestRender,
				});
				const result = results.get(part.id);
				view.finish({
					durationMs: 0,
					preview: result?.preview ?? "",
					isError: result?.isError ?? false,
				});
				mountSection();
				section.addAgentChild(view);
				agentParts.push({
					toolName: part.name,
					durationMs: 0,
					isError: result?.isError ?? false,
					preview: result?.preview ?? "",
				});
			}
		}
		// toolResult messages are merged into their tool card and turn-end stats, not rendered separately
	}
	closeSection();
	return components;
}

function userTextOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && b.type === "text")
		.map((b) => b.text)
		.join("");
}

function collectToolResults(messages: AgentMessage[]): Map<string, { preview: string; isError: boolean }> {
	const results = new Map<string, { preview: string; isError: boolean }>();
	for (const message of messages) {
		if (!("role" in message) || message.role !== "toolResult") continue;
		const id = String((message as { toolCallId?: unknown }).toolCallId ?? "");
		const content = (message as { content?: unknown }).content;
		const isError = Boolean((message as { isError?: unknown }).isError);
		let preview = "";
		if (Array.isArray(content)) {
			preview = content
				.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && b.type === "text")
				.map((b) => b.text)
				.join("\n");
		}
		if (id !== "") results.set(id, { preview, isError });
	}
	return results;
}
