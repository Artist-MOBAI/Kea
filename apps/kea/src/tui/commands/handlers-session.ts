import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isHarnessPromptText, isSystemReminderText, type Kernel } from "@kea/core";
import { SUCCESS_MARK } from "../constants/symbols.ts";
import { collectDebugBundle } from "./debug-export.ts";
import { buildExportMarkdown, exportFileName, exportTimestamp } from "./export-md.ts";
import type { SlashCommandHost } from "./types.ts";

/** Compaction summaries enter the message list as user messages with this prefix. */
export const COMPACTION_SUMMARY_PREFIX = "[Previous context summary]";

/** /undo safe boundary: drop trailing orphan toolResults (no matching toolCall) to keep the message sequence valid. */
export function trimToSafeBoundary(messages: AgentMessage[]): AgentMessage[] {
	const trimmed = [...messages];

	const toolCallExists = (id: string): boolean => {
		for (let i = trimmed.length - 1; i >= 0; i--) {
			const m = trimmed[i];
			if (!m || !("role" in m)) continue;
			if (m.role === "assistant" && Array.isArray(m.content)) {
				return m.content.some((b) => b.type === "toolCall" && (b as { id?: string }).id === id);
			}
			if (m.role === "user") return false;
		}
		return false;
	};

	for (;;) {
		const last = trimmed[trimmed.length - 1];
		if (!last || !("role" in last)) break;
		if (last.role === "assistant" && Array.isArray(last.content) && last.content.some((b) => b.type === "toolCall")) {
			trimmed.pop();
			continue;
		}
		if (last.role === "toolResult") {
			const id = (last as { toolCallId?: string }).toolCallId;
			if (id !== undefined && !toolCallExists(id)) {
				trimmed.pop();
				continue;
			}
		}
		break;
	}
	return trimmed;
}

function userTextOf(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			"type" in block &&
			(block as { type?: unknown }).type === "text" &&
			"text" in block &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join(" ").replaceAll(/\s+/g, " ").trim();
}

// Selectable /undo anchors: real user inputs only. System-reminder injections and harness round
// prompts are lifecycle plumbing, never user turns; a compaction summary RESETS the list — only
// inputs after the LAST summary stay reachable.
export function userMessageTexts(messages: AgentMessage[]): string[] {
	const texts: string[] = [];
	for (const m of messages) {
		if (!m || !("role" in m) || m.role !== "user") continue;
		const text = userTextOf(m);
		if (text.startsWith(COMPACTION_SUMMARY_PREFIX)) {
			texts.length = 0;
			continue;
		}
		if (text === "" || isSystemReminderText(text) || isHarnessPromptText(text)) continue;
		texts.push(text);
	}
	return texts;
}

export function handleUndo(host: SlashCommandHost, kernel: Kernel, args: string): void {
	if (args.trim() === "") {
		// No args: open a selector of recent user inputs (newest first).
		const texts = userMessageTexts(kernel.agent.state.messages).slice(-10).reverse();
		if (texts.length === 0) {
			host.showStatus("Nothing to undo");
			return;
		}
		const choices = texts.map((text, i) => ({
			value: String(i + 1),
			label: text.length > 60 ? `${text.slice(0, 60)}…` : text,
		}));
		host.openUndoSelector(choices, (value) => rollbackTurns(host, kernel, Number(value)));
		return;
	}
	const n = Number(args);
	if (!Number.isInteger(n) || n < 1) {
		host.showError("Usage: /undo [n]");
		return;
	}
	rollbackTurns(host, kernel, n);
}

function rollbackTurns(host: SlashCommandHost, kernel: Kernel, n: number): void {
	const msgs = kernel.agent.state.messages;
	let seen = 0;
	let cut = -1;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (!(m && "role" in m && m.role === "user")) continue;
		const text = userTextOf(m);
		// The compaction boundary is a hard floor: messages before it only exist as summary text,
		// so rolling back further would corrupt the surviving context
		if (text.startsWith(COMPACTION_SUMMARY_PREFIX)) {
			host.showError(`Cannot roll back past a compaction summary (${seen} turns remain above it)`);
			return;
		}
		// Reminder-channel injections and harness round prompts are not user turns — they
		// neither count toward n nor anchor a cut
		if (text === "" || isSystemReminderText(text) || isHarnessPromptText(text)) continue;
		seen += 1;
		if (seen === n) {
			cut = i;
			break;
		}
	}
	if (cut === -1) {
		host.showError(`Conversation has only ${seen} turns, cannot roll back ${n}`);
		return;
	}
	kernel.agent.state.messages = trimToSafeBoundary(msgs.slice(0, cut));
	host.showStatus(
		`${SUCCESS_MARK} Rolled back ${n} turns in memory (the session ledger is append-only and unaffected)`,
	);
}

export function handleCopy(host: SlashCommandHost): void {
	const text = host.lastAssistantText();
	if (text === "") {
		host.showStatus("No reply to copy");
		return;
	}
	const ok = host.copyToClipboard(text);
	if (ok) {
		host.showStatus(`${SUCCESS_MARK} Copied ${text.length} chars to clipboard (OSC 52)`);
	} else {
		host.showError("Terminal does not support OSC 52 clipboard");
	}
}

export async function handleExportMd(host: SlashCommandHost, kernel: Kernel, args: string): Promise<void> {
	const messages = kernel.agent.state.messages;
	if (messages.length === 0) {
		host.showError("No messages to export");
		return;
	}
	const now = new Date();
	const outputPath =
		args.trim() !== "" ? resolve(args.trim()) : resolve(host.cwd, exportFileName(kernel.sessionId, now));
	const md = buildExportMarkdown({ sessionId: kernel.sessionId, cwd: host.cwd, messages, now });
	await Bun.write(outputPath, md);
	host.showStatus(`${SUCCESS_MARK} Exported ${messages.length} messages → ${outputPath}`);
}

export async function handleExportDebugZip(host: SlashCommandHost): Promise<void> {
	const files = await collectDebugBundle(host.cwd);
	const dirName = `debug-${exportTimestamp(new Date())}`;
	const exportsDir = `${host.cwd}/.kea/exports`;
	for (const [name, content] of Object.entries(files)) {
		await Bun.write(`${exportsDir}/${dirName}/${name}`, content);
	}
	const zipPath = `${exportsDir}/${dirName}.zip`;
	let zipped = false;
	try {
		const proc = Bun.spawn(["zip", "-qr", zipPath, dirName], {
			cwd: exportsDir,
			stdout: "ignore",
			stderr: "ignore",
		});
		zipped = (await proc.exited) === 0;
	} catch {
		zipped = false;
	}
	host.showStatus(
		zipped
			? `${SUCCESS_MARK} Debug bundle exported → ${zipPath}`
			: `${SUCCESS_MARK} Debug bundle exported → ${exportsDir}/${dirName} (zip unavailable, kept as directory)`,
	);
}
