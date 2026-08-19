import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import { trimToSafeBoundary } from "../src/tui/commands/dispatch.ts";
import { FilterablePicker, pickerTheme } from "../src/tui/picker.ts";
import { PromptStep } from "../src/tui/prompt-input.ts";

const theme = pickerTheme({ primary: (s) => s, dim: (s) => s });

const msg = (m: unknown): AgentMessage => m as never as AgentMessage;
const userMsg = (text: string) => msg({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistantText = (text: string) => msg({ role: "assistant", content: [{ type: "text", text }], timestamp: 2 });
const assistantCall = (id: string) =>
	msg({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: {} }], timestamp: 3 });
const toolResult = (id: string) => msg({ role: "toolResult", toolCallId: id, content: [], timestamp: 4 });

describe("FilterablePicker (TUI component)", () => {
	const items = [
		{ value: "alpha", label: "alpha", description: "first" },
		{ value: "beta", label: "beta", description: "second" },
	];

	test("renders header and all items", () => {
		const picker = new FilterablePicker(items, theme, { onPick: () => {}, onCancel: () => {} }, () => "HDR");
		const lines = picker.render(60).join("\n");
		expect(lines).toContain("HDR");
		expect(lines).toContain("alpha");
		expect(lines).toContain("beta");
	});

	test("typing filters: only matches shown; Backspace restores", () => {
		const picker = new FilterablePicker(items, theme, { onPick: () => {}, onCancel: () => {} }, () => "HDR");
		picker.handleInput("a");
		let rendered = picker.render(60).join("\n");
		expect(rendered).toContain("alpha");
		expect(rendered).not.toContain("beta");
		picker.handleInput("\x7f");
		rendered = picker.render(60).join("\n");
		expect(rendered).toContain("beta");
	});

	test("Enter picks the current item and fires onPick; Esc fires onCancel", () => {
		let picked = "";
		let cancelled = false;
		const picker = new FilterablePicker(
			items,
			theme,
			{
				onPick: (v) => {
					picked = v;
				},
				onCancel: () => {
					cancelled = true;
				},
			},
			() => "HDR",
		);
		picker.handleInput("\r");
		expect(picked).toBe("alpha");
		picker.handleInput("\x1b");
		expect(cancelled).toBe(true);
	});
});

describe("PromptStep (TUI component)", () => {
	test("validation failure stays and shows the error inline; submits once corrected", () => {
		let received = "";
		const step = new PromptStep(
			// cjk-fixture: validation error message asserted verbatim
			{ question: "Q1", validate: (v) => (v === "" ? "必填" : undefined) },
			{ onSubmit: (v) => (received = v), onCancel: () => {} },
		);
		expect(step.render(60).join("\n")).toContain("Q1");

		step.handleInput("\r");
		expect(step.render(60).join("\n")).toContain("必填");

		step.handleInput("a");
		step.handleInput("b");
		step.handleInput("\r");
		expect(received).toBe("ab");
	});

	test("Esc cancels", () => {
		let cancelled = false;
		const step = new PromptStep({ question: "Q1" }, { onSubmit: () => {}, onCancel: () => (cancelled = true) });
		step.handleInput("\x1b");
		expect(cancelled).toBe(true);
	});
});

describe("trimToSafeBoundary (/undo safe boundary)", () => {
	test("a complete round is kept", () => {
		const msgs = [userMsg("hi"), assistantCall("c1"), toolResult("c1"), assistantText("done")];
		expect(trimToSafeBoundary(msgs)).toHaveLength(4);
	});

	test("a trailing dangling toolCall (result cut off) is trimmed", () => {
		const msgs = [userMsg("hi"), assistantText("thinking"), userMsg("next"), assistantCall("c9")];
		const trimmed = trimToSafeBoundary(msgs);
		expect(trimmed).toHaveLength(3);
		expect(
			trimmed.some((m) => "content" in m && Array.isArray(m.content) && m.content.some((b) => b.type === "toolCall")),
		).toBe(false);
	});

	test("an orphan toolResult (parent toolCall missing) is trimmed", () => {
		const msgs = [userMsg("hi"), toolResult("ghost")];
		const trimmed = trimToSafeBoundary(msgs);
		expect(trimmed).toHaveLength(1);
	});

	test("a paired toolCall+toolResult is kept; the following dangling assistant is chain-trimmed", () => {
		const msgs = [userMsg("a"), assistantCall("c1"), toolResult("c1"), assistantCall("c2")];
		const trimmed = trimToSafeBoundary(msgs);

		expect(trimmed).toHaveLength(3);
	});
});
