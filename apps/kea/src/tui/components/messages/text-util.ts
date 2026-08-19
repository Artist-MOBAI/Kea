import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const MESSAGE_INDENT = "  ";

// Concatenates all text blocks in order; non-text blocks are ignored.
export function textContentOf(message: AgentMessage): string {
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && b.type === "text")
		.map((b) => b.text)
		.join("");
}

export function prefixLines(lines: readonly string[], bullet: string, indent: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		out.push(`${i === 0 ? bullet : indent}${lines[i] ?? ""}`);
	}
	return out;
}
