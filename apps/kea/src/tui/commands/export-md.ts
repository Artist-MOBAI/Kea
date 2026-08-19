import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isHarnessPromptText, isSystemReminderText } from "@kea/core";

export interface ExportMarkdownOptions {
	sessionId: string;
	cwd: string;
	messages: AgentMessage[];
	now: Date;
}

export function exportTimestamp(now: Date): string {
	return now.toISOString().replaceAll(/[-:]/g, "").replace(/T/, "-").slice(0, 15);
}

export function exportFileName(sessionId: string, now: Date): string {
	return `kea-export-${sessionId.slice(0, 8)}-${exportTimestamp(now)}.md`;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? "null";
	} catch {
		return String(value);
	}
}

function textOf(content: Array<{ type: string; text?: string }>): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.join("\n").trim();
}

export function buildExportMarkdown(opts: ExportMarkdownOptions): string {
	const lines: string[] = [
		`# Kea session ${opts.sessionId.slice(0, 8)}`,
		"",
		`- Session ID: \`${opts.sessionId}\``,
		`- Working directory: \`${opts.cwd}\``,
		`- Exported at: ${opts.now.toISOString()}`,
		`- Messages: ${opts.messages.length}`,
		"",
		"---",
		"",
	];

	for (const msg of opts.messages) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string" ? msg.content.trim() : textOf(msg.content);
			// Channel classification: reminder-channel injections are harness plumbing and never
			// enter the export; harness round prompts enter as a collapsed System continuation block
			// so `## User` sections stay real user input only.
			if (isSystemReminderText(text)) continue;
			if (isHarnessPromptText(text)) {
				lines.push(
					"### System · continuation",
					"",
					"<details><summary>round prompt (auto-generated)</summary>",
					"",
					text,
					"",
					"</details>",
					"",
				);
				continue;
			}
			lines.push("## User", "", text === "" ? "(empty)" : text, "");
		} else if (msg.role === "assistant") {
			lines.push(`## Assistant · ${msg.provider}/${msg.model}`, "");
			for (const block of msg.content) {
				if (block.type === "thinking") {
					const t = block.thinking.trim();
					if (t !== "") lines.push("<details><summary>Thinking</summary>", "", t, "", "</details>", "");
				} else if (block.type === "text") {
					const t = block.text.trim();
					if (t !== "") lines.push(t, "");
				} else if (block.type === "toolCall") {
					lines.push(`**Tool call**: \`${block.name}\``, "", "```json", safeJson(block.arguments), "```", "");
				}
			}
			if (msg.errorMessage) lines.push(`> Error: ${msg.errorMessage}`, "");
		} else if (msg.role === "toolResult") {
			const text = textOf(msg.content);
			const preview = text.length > 2000 ? `${text.slice(0, 2000)}\n…(truncated, ${text.length} chars total)` : text;
			lines.push(
				`**Tool result${msg.isError ? " (error)" : ""}**: \`${msg.toolName}\``,
				"",
				"```",
				preview === "" ? "(empty)" : preview,
				"```",
				"",
			);
		} else {
			// Custom messages (compaction, etc.): keep the role marker and raw JSON for auditability.
			lines.push(`## ${(msg as { role: string }).role}`, "", "```json", safeJson(msg), "```", "");
		}
	}

	return `${lines.join("\n")}\n`;
}
