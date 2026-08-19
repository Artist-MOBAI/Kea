import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { MASK_CHAR } from "../src/tui/constants/symbols.ts";
import { PromptStep } from "../src/tui/prompt-input.ts";

const SECRET = "sk-super-secret-key-0123456789";

describe("PromptStep masked steps (sensitive input such as API keys)", () => {
	test("rendered lines show only mask chars — the raw key never appears", () => {
		const step = new PromptStep(
			{ question: "Enter API key for anthropic", masked: true },
			{ onSubmit: () => {}, onCancel: () => {} },
		);
		step.handleInput(SECRET);
		step.focused = true;
		const lines = step.render(80).map(stripTerminalSequences);
		for (const line of lines) {
			expect(line, "raw key leaked into render output").not.toContain(SECRET);
		}
		const inputLine = lines.find((l) => l.startsWith("> ")) ?? "";
		expect(inputLine).toContain(MASK_CHAR.repeat(visibleWidth(SECRET)));
	});

	test("masking tracks the buffer as it grows and shrinks", () => {
		const step = new PromptStep(
			{ question: "Enter API key", masked: true },
			{ onSubmit: () => {}, onCancel: () => {} },
		);
		step.handleInput("abc");
		expect(step.render(60).map(stripTerminalSequences).join("\n")).toContain(MASK_CHAR.repeat(3));
		step.handleInput("\x7f"); // DEL = pi-tui backspace
		const joined = step.render(60).map(stripTerminalSequences).join("\n");
		expect(joined).toContain(MASK_CHAR.repeat(2));
		expect(joined).not.toContain(MASK_CHAR.repeat(3));
	});

	test("masked submit value is the real trimmed key (mask is render-only)", () => {
		let received = "";
		const step = new PromptStep(
			{ question: "Enter API key", masked: true, validate: (v) => (v !== "" ? undefined : "Cannot be empty") },
			{ onSubmit: (v) => (received = v), onCancel: () => {} },
		);
		step.handleInput(`  ${SECRET}  `);
		step.handleInput("\r");
		expect(received).toBe(SECRET);
	});

	test("empty masked input loops with inline error and no leak", () => {
		const step = new PromptStep(
			{ question: "Enter API key", masked: true, validate: (v) => (v !== "" ? undefined : "Cannot be empty") },
			{ onSubmit: () => {}, onCancel: () => {} },
		);
		step.handleInput("\r");
		const joined = step.render(60).map(stripTerminalSequences).join("\n");
		expect(joined).toContain("Cannot be empty");
		expect(joined).not.toContain(SECRET);
	});

	test("hint renders under the question via the dim decorator", () => {
		const step = new PromptStep(
			{ question: "Enter API key for anthropic", masked: true, hint: "Line one\nLine two" },
			{ onSubmit: () => {}, onCancel: () => {} },
			(s) => `<dim>${s}</dim>`,
		);
		const lines = step.render(80);
		expect(lines[1]).toBe("<dim>Line one</dim>");
		expect(lines[2]).toBe("<dim>Line two</dim>");
		expect(lines[3]?.startsWith("> ")).toBe(true);
	});

	test("bracketed paste with an embedded newline keeps the buffer clean", () => {
		let received = "";
		const step = new PromptStep({ question: "Base URL" }, { onSubmit: (v) => (received = v), onCancel: () => {} });
		step.handleInput("\x1b[200~https://a/b\nTAIL\x1b[201~");
		const lines = step.render(80).map(stripTerminalSequences);
		expect(lines.find((l) => l.startsWith("> "))?.trimEnd()).toBe("> https://a/bTAIL");
		step.handleInput("\r");
		expect(received).toBe("https://a/bTAIL");
	});

	test("raw control characters are rejected (buffer untouched)", () => {
		const step = new PromptStep({ question: "Q" }, { onSubmit: () => {}, onCancel: () => {} });
		step.handleInput("ab");
		step.handleInput("\u0001\u0002\u007f");
		expect(
			step
				.render(60)
				.map(stripTerminalSequences)
				.find((l) => l.startsWith("> ")),
		).toContain("a");
	});

	test("masked key pasted with an embedded newline keeps the buffer clean", () => {
		let received = "";
		const step = new PromptStep(
			{ question: "Enter API key", masked: true },
			{ onSubmit: (v) => (received = v), onCancel: () => {} },
		);
		step.handleInput(`\x1b[200~${SECRET}\r\n\x1b[201~`);
		step.handleInput("\r");
		expect(received).toBe(SECRET);
	});

	test("placeholder shows on its own dim line when empty", () => {
		const step = new PromptStep(
			{ question: "Provider id", placeholder: "mylab" },
			{ onSubmit: () => {}, onCancel: () => {} },
			(s) => `<dim>${s}</dim>`,
		);
		const lines = step.render(80);
		expect(lines[0]).toBe("Provider id");
		expect(lines[1]?.startsWith("> ")).toBe(true);
		expect(lines[2]).toBe("<dim>  (mylab)</dim>");
		step.handleInput("mylab");
		expect(step.render(80)[1]?.startsWith("> mylab")).toBe(true);
	});

	test("Esc cancels via the callback", () => {
		let cancelled = false;
		const step = new PromptStep({ question: "Q" }, { onSubmit: () => {}, onCancel: () => (cancelled = true) });
		step.handleInput("\x1b");
		expect(cancelled).toBe(true);
	});
});
