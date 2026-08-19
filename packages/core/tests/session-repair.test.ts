import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { repairToolCallPairing } from "../src/session-repair.ts";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 }) as Message;
const assistantWithCalls = (calls: Array<{ id: string; name: string }>): Message =>
	({
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: {} })),
		timestamp: 2,
	}) as Message;
const toolResult = (id: string, name: string): Message =>
	({
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		timestamp: 3,
	}) as Message;

describe("repairToolCallPairing (residual pairing repair after abort)", () => {
	test("complete pairing: returned as-is", () => {
		const msgs = [user("hi"), assistantWithCalls([{ id: "a", name: "bash" }]), toolResult("a", "bash")];
		expect(repairToolCallPairing(msgs).length).toBe(3);
	});

	test("dangling toolCall: synthesizes an error toolResult (isError)", () => {
		const msgs = [
			user("hi"),
			assistantWithCalls([
				{ id: "a", name: "bash" },
				{ id: "b", name: "read" },
			]),
			toolResult("a", "bash"),
		];
		const out = repairToolCallPairing(msgs);
		expect(out.length).toBe(4);
		const synth = out[3] as { role: string; toolCallId: string; isError: boolean; content: Array<{ text: string }> };
		expect(synth.role).toBe("toolResult");
		expect(synth.toolCallId).toBe("b");
		expect(synth.isError).toBe(true);
		expect(synth.content[0]?.text).toContain("interrupted");
	});

	test("dangling call at the end of the transcript is also completed", () => {
		const msgs = [user("hi"), assistantWithCalls([{ id: "a", name: "bash" }])];
		const out = repairToolCallPairing(msgs);
		expect(out.length).toBe(3);
		expect((out[2] as { toolCallId: string }).toolCallId).toBe("a");
	});

	test("dangling calls are settled before the next user message", () => {
		const msgs = [assistantWithCalls([{ id: "a", name: "bash" }]), user("next")];
		const out = repairToolCallPairing(msgs);
		expect(out.map((m) => m.role)).toEqual(["assistant", "toolResult", "user"]);
	});

	test("toolResult missing toolCallId: skips pairing, does not swallow dangling calls", () => {
		const orphanResult = { role: "toolResult", content: [{ type: "text", text: "ok" }], timestamp: 3 } as Message;
		const msgs = [
			user("hi"),
			assistantWithCalls([
				{ id: "", name: "bash" },
				{ id: "b", name: "read" },
			]),
			orphanResult,
			toolResult("b", "read"),
		];
		const out = repairToolCallPairing(msgs);
		// an id-less toolResult must not be mispaired with an empty-id dangling call — synthesize an interrupted result
		const synth = out.filter((m) => m.role === "toolResult" && (m as { isError?: boolean }).isError === true);
		expect(synth).toHaveLength(1);
		expect((synth[0] as { toolCallId: string }).toolCallId).toBe("");
	});
});
