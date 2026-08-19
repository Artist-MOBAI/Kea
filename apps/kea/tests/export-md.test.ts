import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import { buildExportMarkdown, exportFileName } from "../src/tui/commands/export-md.ts";

const now = new Date("2026-08-10T15:00:00.000Z");
const sessionId = "019fe9ff-aaaa-bbbb-cccc-ddddeeeeffff";

function fixture(): AgentMessage[] {
	return [
		// cjk-fixture: exported CJK content is asserted verbatim in the tests below
		{ role: "user", content: "帮我复现文献 SPR", timestamp: 1 } as AgentMessage,
		{
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			content: [
				{ type: "thinking", thinking: "先查文献" },
				{ type: "text", text: "我先检索文献。" },
				{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
			],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				total: 2,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			api: "anthropic-messages",
			timestamp: 2,
		} as AgentMessage,
		{
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "bash",
			content: [{ type: "text", text: "file-a\nfile-b" }],
			isError: false,
			timestamp: 3,
		} as AgentMessage,
	];
}

describe("export-md (session markdown export)", () => {
	test("file name format: kea-export-<short id>-<timestamp>.md", () => {
		expect(exportFileName(sessionId, now)).toBe("kea-export-019fe9ff-20260810-150000.md");
	});

	test("header metadata and message sections are complete", () => {
		const md = buildExportMarkdown({ sessionId, cwd: "/proj", messages: fixture(), now });
		expect(md).toContain("# Kea session 019fe9ff");
		expect(md).toContain("`/proj`");
		expect(md).toContain("Messages: 3");
		expect(md).toContain("## User");
		expect(md).toContain("帮我复现文献 SPR");
		expect(md).toContain("## Assistant · anthropic/claude-sonnet-4-5");
		expect(md).toContain("我先检索文献。");
	});

	test("thinking folded into details, tool call with arguments JSON", () => {
		const md = buildExportMarkdown({ sessionId, cwd: "/proj", messages: fixture(), now });
		expect(md).toContain("<details><summary>Thinking</summary>");
		expect(md).toContain("先查文献");
		expect(md).toContain("**Tool call**: `bash`");
		expect(md).toContain('"command": "ls"');
	});

	test("tool results archived; overlong results truncated", () => {
		const long = "x".repeat(3000);
		const messages = [
			{
				role: "toolResult",
				toolCallId: "tc2",
				toolName: "read",
				content: [{ type: "text", text: long }],
				isError: true,
				timestamp: 4,
			} as AgentMessage,
		];
		const md = buildExportMarkdown({ sessionId, cwd: "/proj", messages, now });
		expect(md).toContain("**Tool result (error)**: `read`");
		expect(md).toContain("…(truncated, 3000 chars total)");
		expect(md.length).toBeLessThan(long.length + 2000);
	});
});
