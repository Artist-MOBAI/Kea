import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { contextPctOf } from "../src/tui/app.ts";
import { type FooterData, FooterView, renderFooter } from "../src/tui/components/chrome/footer.ts";
import { ApprovalPanel, detectDanger } from "../src/tui/components/dialogs/approval-panel.ts";
import { InfoPanel } from "../src/tui/components/dialogs/info-panel.ts";
import { sortJobRows } from "../src/tui/components/dialogs/tasks-panel.ts";
import { injectPromptSymbol, wrapWithSideBorders } from "../src/tui/components/editor/rounded-editor.ts";
import { AssistantMessageView, trimUnclosedFence } from "../src/tui/components/messages/assistant-message.ts";
import { RoundSection } from "../src/tui/components/messages/round-section.ts";
import { SectionCaption, SectionCard } from "../src/tui/components/messages/section-card.ts";
import { ThinkingView } from "../src/tui/components/messages/thinking.ts";
import {
	collapse,
	extractKeyArgument,
	ToolCallView,
	tailVisualLines,
} from "../src/tui/components/messages/tool-call.ts";
import { UserMessageView } from "../src/tui/components/messages/user-message.ts";
import { renderTranscript } from "../src/tui/components/transcript.ts";
import { createKeyboardListener } from "../src/tui/controllers/editor-keyboard.ts";
import { classifyError } from "../src/tui/controllers/error-classify.ts";
import { StreamingController } from "../src/tui/controllers/streaming-ui.ts";
import { type ApprovalDecision, createTUIState } from "../src/tui/state.ts";
import { ansiStyles, identityMarkdownTheme, identityStyles, tagStyles } from "./helpers/styles.ts";

const styles = tagStyles();

const markdownTheme = identityMarkdownTheme();

const msg = (m: unknown): AgentMessage => m as never as AgentMessage;

describe("ToolCallView (tool card)", () => {
	const makeView = (name: string, args: unknown, expanded = false) =>
		new ToolCallView({ name, args, cwd: "/proj", styles, isExpanded: () => expanded, requestRender: () => {} });

	test("per-tool chip: grep match count / edit ±line count", () => {
		const grep = makeView("grep", { pattern: "foo" });
		grep.finish({ durationMs: 100, preview: "a.ts:1\nb.ts:2\nc.ts:3", isError: false });
		expect(grep.render(80)[0] ?? "").toContain("3 matches");

		const edit = makeView("edit", { path: "x.ts", edits: [{ oldText: "a\nb", newText: "a\nb\nc\nd" }] });
		edit.finish({ durationMs: 100, preview: "", isError: false });
		expect(edit.render(80)[0] ?? "").toContain("+4 -2");
	});

	test("running: verb label + bash command in body", () => {
		const view = makeView("bash", { command: "echo hello" });
		const rendered = view.render(80);
		expect(rendered[0] ?? "").toContain("Running a command");
		expect(rendered.join("\n")).toContain("$ echo hello");
	});

	test("non-bash tool header carries the verb and key-argument parentheses", () => {
		const view = makeView("read", { path: "src/main.ts" });
		expect(view.render(80)[0] ?? "").toContain("Using read");
		expect(view.render(80)[0] ?? "").toContain("(src/main.ts)");
	});

	test("finished header carries the success bullet and duration chip", () => {
		const view = makeView("read", { path: "src/main.ts" });
		view.finish({ durationMs: 2000, preview: "content", isError: false });
		const header = view.render(80)[0] ?? "";
		expect(header).toContain("<ok>─ </ok>");
		expect(header).toContain("2.0s");
	});

	test("flushLeft is declared (card renders with 0 padding, - hugs the border into ├─)", () => {
		const view = makeView("read", { path: "src/main.ts" });
		expect(view.flushLeft).toBe(true);
	});

	test("failed card carries the ✗ marker", () => {
		const view = makeView("bash", { command: "false" });
		view.finish({ durationMs: 10, preview: "exit 1", isError: true });
		expect(view.render(80)[0] ?? "").toContain("<e>✗ </e>");
	});

	test("research tools render the METRIC line highlight and jobId/backend chips", () => {
		const view = makeView("run_experiment", { backend: "local", command: "python eval.py" });
		view.finish({
			durationMs: 4200,
			preview: "METRIC score=1022\nplain line",
			isError: false,
			details: { jobId: "abcdefgh123456", backend: "local" },
		});
		// Width must fit the full English header string (label styles inflate width) so the jobId chip isn't clipped
		const rendered = view.render(160).join("\n");
		expect(rendered).toContain("<a><b>");
		expect(rendered).toContain("METRIC score=1022");
		expect(rendered).toContain("local");
		expect(rendered).toContain("job abcdefgh");
	});

	test("long results fold with a Ctrl+O hint; expanded view drops the hint", () => {
		const view = makeView("bash", { command: "seq 20" });
		view.finish({
			durationMs: 5,
			preview: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
			isError: false,
		});
		const collapsedRender = view.render(80).join("\n");
		expect(collapsedRender).toContain("Ctrl+O");

		const expandedView = makeView("bash", { command: "seq 20" }, true);
		expandedView.finish({
			durationMs: 5,
			preview: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
			isError: false,
		});
		expect(expandedView.render(80).join("\n")).not.toContain("Ctrl+O");
		expect(expandedView.render(80).join("\n")).toContain("line 20");
	});

	test("long bash: command and result share the budget — collapsed shows both previews (zero-preview bug)", () => {
		const longCmd = `cd /some/deep/project/path && ls experiments/ && which python3 && python3 -c "import gseapy" && echo done`;
		const view = makeView("bash", { command: longCmd });
		view.finish({
			durationMs: 5,
			preview: Array.from({ length: 10 }, (_, i) => `out ${i + 1}`).join("\n"),
			isError: false,
		});
		const rendered = view.render(80);
		const text = rendered.join("\n");
		expect(text).toContain("out 1");
		expect(text).toContain("out 3");
		expect(text).not.toContain("out 4");
		expect(text).toContain("more lines, Ctrl+O to expand");
		const expandedView = makeView("bash", { command: longCmd }, true);
		expandedView.finish({
			durationMs: 5,
			preview: Array.from({ length: 10 }, (_, i) => `out ${i + 1}`).join("\n"),
			isError: false,
		});
		const expandedText = expandedView.render(80).join("\n");
		expect(expandedText).toContain("echo done");
		expect(expandedText).toContain("out 10");
		expect(expandedText).not.toContain("Ctrl+O");
	});

	test("extractKeyArgument: keyMap / relative path / 60-column cap / bash first line", () => {
		expect(extractKeyArgument("read", { path: "/proj/src/a.ts" }, "/proj")).toBe("src/a.ts");
		expect(extractKeyArgument("grep", { pattern: "foo" }, "/proj")).toBe("foo");
		expect(extractKeyArgument("bash", { command: "line1\nline2" }, "/proj")).toBe("line1");
		const long = "x".repeat(200);
		expect(extractKeyArgument("read", { path: long }, "").length).toBeLessThanOrEqual(61);
		expect(extractKeyArgument("read", "nope", "")).toBe("");
	});
});

describe("ToolCallView render cache (width-keyed: finalized cards always hit)", () => {
	const makeView = (name: string, args: unknown, isExpanded: () => boolean = () => false) =>
		new ToolCallView({ name, args, cwd: "/proj", styles, isExpanded, requestRender: () => {} });

	test("FINISHED: two same-width renders return the same array reference (header/chips/fold computed once)", () => {
		const view = makeView("grep", { pattern: "foo" });
		view.finish({ durationMs: 100, preview: "a.ts:1\nb.ts:2\nc.ts:3", isError: false });
		const first = view.render(80);
		expect(view.render(80)).toBe(first);
	});

	test("width change recomputes; invalidate() forces recompute", () => {
		const view = makeView("grep", { pattern: "foo" });
		view.finish({ durationMs: 100, preview: "a.ts:1", isError: false });
		const w80 = view.render(80);
		const w100 = view.render(100);
		expect(w100).not.toBe(w80);
		expect(view.render(100)).toBe(w100);
		view.invalidate();
		expect(view.render(100)).not.toBe(w100);
	});

	test("RUNNING: appendLiveText changes tailBuffer → recompute; renders always hit once stable", () => {
		const view = makeView("bash", { command: "yes" });
		const r1 = view.render(80);
		view.appendLiveText("line1\n");
		const r2 = view.render(80);
		expect(r2).not.toBe(r1);
		expect(view.render(80)).toBe(r2);
		expect(r2.join("\n")).toContain("line1");
	});

	test("finish() state flip forces recompute (done shape ≠ running shape)", () => {
		const view = makeView("bash", { command: "echo ok" });
		const running = view.render(80);
		view.finish({ durationMs: 5, preview: "ok", isError: false });
		const done = view.render(80);
		expect(done).not.toBe(running);
		expect(view.render(80)).toBe(done);
	});

	test("finish() also invalidates the cache: a double finish (error path) does not stick to stale cache", () => {
		const view = makeView("grep", { pattern: "foo" });
		view.finish({ durationMs: 100, preview: "a.ts:1", isError: false });
		const r1 = view.render(80);
		// The FINISHED dep carries no content field: without invalidate, the second finish's new preview won't render
		view.finish({ durationMs: 100, preview: "a.ts:1\nb.ts:2", isError: false });
		const r2 = view.render(80);
		expect(r2).not.toBe(r1);
		expect(view.render(80)).toBe(r2);
	});

	test("Ctrl+O toggle enters the dep: finalized card recomputes (toggle only requestRender, no invalidate)", () => {
		let expanded = false;
		const view = makeView("bash", { command: "seq 20" }, () => expanded);
		view.finish({
			durationMs: 5,
			preview: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
			isError: false,
		});
		const collapsedRender = view.render(80);
		expect(collapsedRender.join("\n")).toContain("Ctrl+O");
		expanded = true;
		const expandedRender = view.render(80);
		expect(expandedRender).not.toBe(collapsedRender);
		expect(expandedRender.join("\n")).not.toContain("Ctrl+O");
		expect(expandedRender.join("\n")).toContain("line 20");
	});
});

describe("tailVisualLines (live tail window: backward scan with wrapping)", () => {
	const plain = identityStyles();

	test("short lines exact: last 3 visual lines + accurate hidden count", () => {
		const out = tailVisualLines(["l0", "l1", "l2", "l3", "l4", "l5"].join("\n"), 80, plain);
		expect(out).toHaveLength(4);
		expect(out[0] ?? "").toContain("(3 earlier lines)");
		expect(out.join("\n")).toContain("l3");
		expect(out.join("\n")).toContain("l5");
		expect(out.join("\n")).not.toContain("l2\n");
	});

	test("fewer than 3 lines emits no hint; trailing newline stripped without an empty line", () => {
		expect(tailVisualLines("a\nb\n", 80, plain)).toEqual(["a", "b"]);
		expect(tailVisualLines("only", 80, plain)).toEqual(["only"]);
	});

	test("long single line: wrapping keeps the last 3 visual lines, first counts as hidden (matches full wrap)", () => {
		const out = tailVisualLines("z".repeat(300), 80, plain);
		// Wrap width 76: 300 chars → 4 visual lines, keep the last 3 (76+76+72=224), first line goes to hidden
		expect(out).toHaveLength(4);
		expect(out[0] ?? "").toContain("(1 earlier lines)");
		expect(out.slice(1).join("").length).toBe(224);
		for (const line of out.slice(1)) expect(visibleWidth(stripTerminalSequences(line))).toBeLessThanOrEqual(76);
	});

	test("exactly 4 raw lines in the window: the extra one feeds the wrap-overflow count", () => {
		const out = tailVisualLines("a\nb\nc\nd", 80, plain);
		expect(out[0] ?? "").toContain("(1 earlier lines)");
		expect(out).toHaveLength(4);
	});

	test("truncation sentinel: [...truncated] enters window logic as an ordinary raw line", () => {
		const visible = tailVisualLines("[...truncated]\na\nb", 80, plain);
		expect(visible.join("\n")).toContain("[...truncated]");
		expect(visible.some((l) => l.includes("earlier lines"))).toBe(false);
		const hidden = tailVisualLines("[...truncated]\nold-a\nold-b\nnew-c", 80, plain);
		expect(hidden[0] ?? "").toContain("(1 earlier lines)");
	});

	test("buffer over 50KB: the tail window shows the tail of the input", () => {
		const view = new ToolCallView({
			name: "bash",
			args: { command: "yes" },
			cwd: "/proj",
			styles: plain,
			isExpanded: () => false,
			requestRender: () => {},
		});
		view.appendLiveText(`${"x".repeat(60_000)}\nLAST-LINE`);
		const rendered = view.render(120).join("\n");
		expect(rendered).toContain("LAST-LINE");
		expect(rendered).toContain("earlier lines");
	});
});

describe("AssistantMessageView (bullet and hanging indent)", () => {
	test("compact spacing: no leading blank line, first line uses the ─ branch bullet", () => {
		const message = msg({ role: "assistant", content: [{ type: "text", text: "hello world" }], timestamp: 1 });
		const view = new AssistantMessageView(message, markdownTheme, styles);
		view.update("hello world");
		view.finalize("hello world");
		const lines = view.render(80);
		expect(lines[0]?.startsWith("─ ")).toBe(true);
		expect(lines[0]).toContain("hello world");
	});

	test("empty text renders as empty", () => {
		const message = msg({ role: "assistant", content: [], timestamp: 1 });
		const view = new AssistantMessageView(message, markdownTheme, styles);
		expect(view.render(80)).toEqual([]);
	});
});

describe("collapse (visual-line folding)", () => {
	test("folds to 3 visual lines and reports the hidden count; expanded has no cap", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `l${i}`);
		const out = collapse(lines, 80, false, styles);
		expect(out.length).toBe(4);
		expect(out[out.length - 1] ?? "").toContain("9 more lines");
		const expanded = collapse(lines, 80, true, styles);
		expect(expanded.length).toBe(12);
	});

	test("an overlong single line exhausting the budget still shows the first visual line (no zero preview)", () => {
		const out = collapse(["z".repeat(500)], 80, false, styles);
		expect(out.filter((l) => l.includes("zz")).length).toBe(1);
		expect(out.some((l) => l.includes("Ctrl+O"))).toBe(true);
	});

	test("wrapped long lines count toward the visual line count", () => {
		const lines = ["x".repeat(200), "y"];
		const out = collapse(lines, 80, false, styles);
		expect(out.filter((l) => l.includes("xx")).length).toBe(3);
		expect(out.some((l) => l.includes("Ctrl+O"))).toBe(true);
		expect(out.some((l) => l.includes("y"))).toBe(false);
	});
});

describe("trimUnclosedFence (streaming code-fence safety)", () => {
	test("unclosed fence gets a closing tail; closed fence does not", () => {
		expect(trimUnclosedFence("```py\nprint(1)")).toBe("```py\nprint(1)\n```");
		expect(trimUnclosedFence("```py\nx\n```")).toBe("```py\nx\n```");
		expect(trimUnclosedFence("plain")).toBe("plain");
	});
});

describe("ApprovalPanel (approval overlay)", () => {
	const makePanel = (onDecision: (d: ApprovalDecision) => void) => {
		const panel = new ApprovalPanel({
			toolName: "bash",
			command: "sudo rm x",
			danger: detectDanger("sudo rm x"),
			styles,
		});
		panel.onDecision = onDecision;
		return panel;
	};

	test("renders the question-style title, command, danger marker, and numbered options", () => {
		const panel = makePanel(() => {});
		const rendered = panel.render(80).join("\n");
		expect(rendered).toContain("Run this command?");
		expect(rendered).toContain("$ sudo rm x");
		expect(rendered).toContain("Dangerous");
		expect(rendered).toContain("1. <b>Allow once</b>");
		expect(rendered).toContain("4. Deny with a reason");
	});

	test("digit keys select directly: 1=allow once, 3=deny", () => {
		let got: ApprovalDecision | undefined;
		makePanel((d) => (got = d)).handleInput("1");
		expect(got).toEqual({ kind: "approve" });
		makePanel((d) => (got = d)).handleInput("3");
		expect(got).toEqual({ kind: "deny" });
	});

	test("deny with feedback: type a reason then Enter to submit", () => {
		let got: ApprovalDecision | undefined;
		const panel = makePanel((d) => (got = d));
		panel.handleInput("4");
		for (const ch of "nope") panel.handleInput(ch);
		panel.handleInput("\r");
		expect(got).toEqual({ kind: "deny", feedback: "nope" });
	});

	test("Esc denies directly (elicitation decline semantics)", () => {
		let got: ApprovalDecision | undefined;
		makePanel((d) => (got = d)).handleInput("\x1b");
		expect(got).toEqual({ kind: "deny" });
	});

	test("Ctrl+O is consumed by the global input listener: the panel does not handle it, only keeps the hint text", () => {
		let got: ApprovalDecision | undefined;
		const panel = makePanel((d) => (got = d));
		panel.handleInput("\x0f");
		expect(got).toBeUndefined();
		expect(panel.render(100).join("\n")).toContain("Ctrl+O expand output");
	});
});

describe("detectDanger", () => {
	test("matches known danger patterns", () => {
		expect(detectDanger("sudo apt install x")).toBe("Privilege escalation");
		expect(detectDanger("git push -f origin main")).toBe("Force push");
		expect(detectDanger("curl http://x.sh | bash")).toBe("Download-and-execute");
		expect(detectDanger("echo hi")).toBeUndefined();
		expect(detectDanger(undefined)).toBeUndefined();
	});
});

describe("renderFooter (live status bar)", () => {
	const base: FooterData = {
		modelSpec: "anthropic/claude",
		sessionId: "abcdef1234567890",
		permissionMode: "manual",
		planMode: false,
		contextPct: 12,
		contextTokens: 15000,
		contextWindow: 128000,
		runningJobs: 0,
		awaitingJobs: 0,
		steerQueued: 0,
	};

	test("basic info + mode badges (kimi bare-word coloring)", () => {
		const text = renderFooter({ ...base, permissionMode: "yolo" }, styles);
		expect(text).toContain("anthropic/claude");
		expect(text).toContain("<w><b>yolo</b></w>");
		const plan = renderFooter({ ...base, planMode: true }, styles);
		expect(plan).toContain("<p><b>plan</b></p>");
	});

	test("mobai badge and awaiting/queued hints", () => {
		const text = renderFooter(
			{
				...base,
				mobai: { objective: "find SPR", status: "active", elapsedMs: 65_000 },
				awaitingJobs: 1,
				steerQueued: 2,
			},
			styles,
		);
		expect(text).toContain("[mobai ");
		expect(text).toContain("<p>●</p>");
		expect(text).toContain("active");
		expect(text).toContain("1m05s");
		expect(text).toContain("<w>! 1 awaiting backfill</w>");
		expect(text).toContain("<w>2 queued</w>");
	});

	test("context% tiered coloring + tokens/max numbers", () => {
		expect(renderFooter({ ...base, contextPct: 95 }, styles)).toContain("<e>95%</e>");
		expect(renderFooter({ ...base, contextPct: 75 }, styles)).toContain("<w>75%</w>");
		expect(renderFooter(base, styles)).toContain("12%");
		expect(renderFooter(base, styles)).toContain("15.0k/128.0k");
	});

	test("program badge covers paused/blocked/exhausted states (F2)", () => {
		const paused = renderFooter({ ...base, mobai: { objective: "o", status: "paused", elapsedMs: 5_000 } }, styles);
		expect(paused).toContain("[mobai ");
		expect(paused).toContain("paused");
		const blocked = renderFooter({ ...base, mobai: { objective: "o", status: "blocked" } }, styles);
		expect(blocked).toContain("<w>●</w>"); // warning dot for blocked
		const exhausted = renderFooter({ ...base, mobai: { objective: "o", status: "exhausted" } }, styles);
		expect(exhausted).toContain("exhausted");
	});

	test("contextPctOf clamps to 0..100 (F5: over-window estimate never renders 123%)", () => {
		expect(contextPctOf(150_000, 100_000)).toBe(100);
		expect(contextPctOf(-5, 100_000)).toBe(0);
		expect(contextPctOf(50_000, 100_000)).toBe(50);
		expect(contextPctOf(120_000, 0)).toBe(0); // unknown window → 0, never NaN
	});

	test("tip appears right-aligned on the first line", () => {
		// Identity styles: visibleWidth matches a real ANSI terminal (markup-style literals would inflate width)
		const plainStyles = identityStyles();
		// cjk-fixture: footer tip text is test data (input + asserted verbatim; alignment check is language-agnostic)
		const text = renderFooter(base, plainStyles, 80, "Ctrl+O 展开工具输出");
		const line1 = text.split("\n")[0] ?? "";
		expect(line1).toContain("Ctrl+O 展开工具输出");
	});
});

describe("FooterView (transient hint)", () => {
	test("exit confirmation uses a footer transient line, not the transcript area", () => {
		const data: FooterData = {
			modelSpec: "p/m",
			sessionId: "abcdef12345678",
			permissionMode: "manual",
			planMode: false,
			contextPct: 12,
			contextTokens: 1000,
			contextWindow: 128000,
			runningJobs: 0,
			awaitingJobs: 0,
			steerQueued: 0,
		};
		const view = new FooterView(styles, data);
		view.setData(data, styles, 80);
		view.setTransientHint("Press Ctrl+C again to exit", styles.warning, 1500);
		const rendered = view.component.render(80).join("\n");
		expect(rendered).toContain("<w>Press Ctrl+C again to exit</w>");
	});
});

describe("keyboard ladder (kimi editor-keyboard paradigm)", () => {
	const makeCtx = (opts: { draft?: string; streaming?: boolean }) => {
		const calls: string[] = [];
		let editorText = opts.draft ?? "";
		const state = createTUIState();
		const ctx = {
			tui: { requestRender: () => {} },
			editor: {
				getText: () => editorText,
				setText: (t: string) => {
					editorText = t;
				},
			},
			state,
			kernel: {
				agent: { state: { isStreaming: opts.streaming ?? false } },
				abort: () => calls.push("abort"),
				steer: (t: string) => calls.push(`steer:${t}`),
				permissionMode: "manual",
				setPermissionMode: () => {},
				isCompacting: () => false,
			},
			styles: () => styles,
			addText: (t: string) => calls.push(`text:${t}`),
			showStatus: (t: string, tone?: string) => calls.push(`status:${tone ?? "dim"}:${t}`),
			showError: (t: string) => calls.push(`error:${t}`),
			interruptEscalation: () => {
				calls.push("interrupt-escalation");
				return false;
			},
			armExitHint: (kind: string) => calls.push(`hint:${kind}`),
			resolveApproval: (a: string) => calls.push(`approval:${a}`),
			exit: () => calls.push("exit"),
		};
		return { listener: createKeyboardListener(ctx as never), calls, getDraft: () => editorText, state };
	};

	test("draft first: with input, Ctrl+C only clears the draft, no streaming interruption", () => {
		const { listener, calls, getDraft } = makeCtx({ draft: "draft", streaming: true });
		listener("\x03");
		expect(getDraft()).toBe("");
		expect(calls).not.toContain("abort");
	});

	test("empty input + streaming: Ctrl+C interrupts", () => {
		const { listener, calls } = makeCtx({ streaming: true });
		listener("\x03");
		expect(calls).toContain("abort");
	});

	test("idle double-key exit: only the same key confirms and exits; a different key re-arms (audit P2#9)", () => {
		const { listener, calls } = makeCtx({});
		listener("\x03"); // Ctrl+C arms
		expect(calls).toContain("hint:ctrl-c");
		listener("\x04"); // Ctrl+D is a DIFFERENT key → re-arms, must NOT exit
		expect(calls).not.toContain("exit");
		expect(calls).toContain("hint:ctrl-d");
		listener("\x04"); // same key again → exit
		expect(calls).toContain("exit");
	});

	test("Ctrl+S: while streaming, injects the guidance and clears the editor", () => {
		const { listener, calls, getDraft } = makeCtx({ draft: "note", streaming: true });
		listener("\x13");
		expect(getDraft()).toBe("");
		expect(calls).toContain("steer:note");
	});

	test("Ctrl+S: no injection while idle", () => {
		const { listener, calls } = makeCtx({ draft: "note", streaming: false });
		listener("\x13");
		expect(calls.some((c) => c.startsWith("steer:"))).toBe(false);
	});

	test("Ctrl+S: idle gives status feedback (does not silently swallow the key)", () => {
		const { listener, calls } = makeCtx({ draft: "note", streaming: false });
		listener("\x13");
		expect(calls.some((c) => c.startsWith("status:"))).toBe(true);
	});

	test("streaming with no overlay: Esc interrupts the run", () => {
		const { listener, calls } = makeCtx({ streaming: true });
		listener("\x1b");
		expect(calls).toContain("abort");
	});

	test("streaming with dialog open: Esc goes to the dialog, no run interruption (regression: accidental abort)", () => {
		const { listener, calls, state } = makeCtx({ streaming: true });
		state.activeDialog = "dialog";
		listener("\x1b");
		expect(calls).not.toContain("abort");
	});

	test("idle with escalation in flight: Esc interrupts it (abort workers + pause mobai), no run abort, no exit", () => {
		const calls: string[] = [];
		const state = createTUIState();
		const ctx = {
			tui: { requestRender: () => {} },
			editor: { getText: () => "", setText: () => {} },
			state,
			kernel: { agent: { state: { isStreaming: false } }, abort: () => calls.push("abort"), isCompacting: () => false },
			styles: () => styles,
			showStatus: (t: string, tone?: string) => calls.push(`status:${tone ?? "dim"}:${t}`),
			interruptEscalation: () => {
				calls.push("interrupt-escalation");
				return true;
			},
		};
		const listener = createKeyboardListener(ctx as never);
		listener("\x1b");
		expect(calls).toContain("interrupt-escalation");
		expect(calls).not.toContain("abort"); // no run is streaming — Esc reached the escalation window
		expect(calls).not.toContain("exit");
	});

	test("Ctrl+O: toggles global tool-output expansion (also works while awaiting approval)", () => {
		const { listener, calls, state } = makeCtx({ streaming: true });
		listener("\x0f");
		expect(state.expanded).toBe(true);
		expect(calls.some((c) => c.includes("expanded globally"))).toBe(true);
		listener("\x0f");
		expect(state.expanded).toBe(false);
	});

	test("idle with draft: one Ctrl+C clears the draft and arms exit (regression: needed two presses)", () => {
		const { listener, calls, getDraft } = makeCtx({ draft: "draft" });
		listener("\x03");
		expect(getDraft()).toBe("");
		expect(calls).toContain("hint:ctrl-c");
		expect(calls).not.toContain("exit");
		listener("\x03");
		expect(calls).toContain("exit");
	});
});

describe("ThinkingView (reasoning view)", () => {
	test("Ctrl+O: expanded enters the dep — same-width toggle recomputes (toggle only fires requestRender)", () => {
		let expanded = false;
		const view = new ThinkingView(styles, () => expanded);
		view.setText("t1\nt2\nt3\nt4\nt5");
		view.finalize();
		const folded = view.render(80);
		expect(folded.join("\n")).toContain("t3");
		expect(folded.join("\n")).not.toContain("t5");
		expect(folded.join("\n")).toContain("Ctrl+O expands");
		expanded = true;
		const expandedRender = view.render(80);
		expect(expandedRender).not.toBe(folded);
		expect(expandedRender.join("\n")).toContain("t5");
		expect(expandedRender.join("\n")).not.toContain("Ctrl+O expands");
	});

	test("live spinner frame enters the dep: time advance swaps the frame (no freeze while thinking stalls)", () => {
		const now = vi.spyOn(Date, "now");
		try {
			const view = new ThinkingView(styles);
			view.setText("reasoning…");
			now.mockReturnValue(1_000);
			const r1 = view.render(80);
			expect(view.render(80)).toBe(r1);
			now.mockReturnValue(1_100);
			const r2 = view.render(80);
			expect(r2).not.toBe(r1);
			expect(r2[0]).not.toBe(r1[0]);
			expect(r2.join("\n")).toContain("thinking…");
		} finally {
			now.mockRestore();
		}
	});

	test("time advance does not break the finalized cache (frame dep stays 0: render = cache hit)", () => {
		const now = vi.spyOn(Date, "now");
		try {
			now.mockReturnValue(1_000);
			const view = new ThinkingView(styles);
			view.setText("a\nb\nc");
			view.finalize();
			const r1 = view.render(80);
			now.mockReturnValue(9_000);
			expect(view.render(80)).toBe(r1);
		} finally {
			now.mockRestore();
		}
	});
});

describe("CompactionView (compaction progress)", () => {
	test("live shows the in-progress label; finished carries before/after token numbers", async () => {
		const { CompactionView } = await import("../src/tui/components/messages/compaction.ts");
		const view = new CompactionView(styles);
		expect(view.render(80).join("\n")).toContain("compacting context…");
		view.finish(12000, 3200);
		// Label styles inflate width, so a wide render keeps the completion line (with "research ledger intact") from clipping
		const done = view.render(120).join("\n");
		expect(done).toContain("<ok>─ </ok>");
		expect(done).toContain("12.0k → 3.2k tokens");
		expect(done).toContain("research ledger intact");
	});

	test("live spinner frame enters the dep: time advance swaps the frame; finalized cache survives time", async () => {
		const { CompactionView } = await import("../src/tui/components/messages/compaction.ts");
		const now = vi.spyOn(Date, "now");
		try {
			const view = new CompactionView(styles);
			now.mockReturnValue(0);
			const r1 = view.render(80);
			expect(view.render(80)).toBe(r1);
			now.mockReturnValue(100);
			const r2 = view.render(80);
			expect(r2).not.toBe(r1);
			expect(r2[0]).not.toBe(r1[0]);
			view.finish(12_000, 3_200);
			const done = view.render(120);
			now.mockReturnValue(60_000);
			expect(view.render(120)).toBe(done);
		} finally {
			now.mockRestore();
		}
	});
});

describe("UserMessageView (> bullet + flushLeft ├> shape)", () => {
	test("first line bullet, wrapped lines align after the bullet (no leading blank inside the card)", () => {
		const message = msg({ role: "user", content: [{ type: "text", text: "hello kea" }], timestamp: 1 });
		const view = new UserMessageView(message, styles);
		const lines = view.render(80);
		expect(lines[0]?.startsWith("<u>> </u>")).toBe(true);
		expect(lines[0]).toContain("hello kea");
		expect(view.flushLeft).toBe(true);
	});
});

describe("sortJobRows (awaiting_human pinned to top)", () => {
	test("backfill first, then running", () => {
		const rows = [
			{ id: "1", backend: "local", state: "completed", elapsedSec: 1 },
			{ id: "2", backend: "ssh", state: "awaiting_human", elapsedSec: 2 },
			{ id: "3", backend: "modal", state: "running", elapsedSec: 3 },
		];
		const sorted = sortJobRows(rows);
		expect(sorted.map((r) => r.id)).toEqual(["2", "3", "1"]);
	});
});

describe("TasksPanel experiment status bar (design §5.10)", () => {
	const panelStyles = identityStyles();

	test("pickBest takes the best by direction", async () => {
		const { pickBest } = await import("../src/tui/components/dialogs/tasks-panel.ts");
		expect(pickBest([3, 1, 2], "minimize")).toBe(1);
		expect(pickBest([3, 1, 2], "maximize")).toBe(3);
		expect(pickBest([], "maximize")).toBeUndefined();
	});

	test("status bar renders contract name/version/runs/best/trend; job list unaffected", async () => {
		const { TasksPanel } = await import("../src/tui/components/dialogs/tasks-panel.ts");
		const panel = new TasksPanel(
			[{ id: "019fe9ffaaaa", backend: "local", state: "running", elapsedSec: 12 }],
			panelStyles,
			"proj",
			[
				{
					name: "tsp-len",
					version: 1,
					metric: "tour_length",
					direction: "minimize",
					runs: 6,
					best: 421,
					trend: "█▅▃▁",
				},
			],
		);
		const text = panel.render(120).join("\n");
		expect(text).toContain("Experiment status");
		expect(text).toContain("tsp-len v1 · metric=tour_length(minimize) · 6 runs · best=421 · █▅▃▁");
		expect(text).toContain("019fe9ff");
	});

	test("no status bar without an evaluator", async () => {
		const { TasksPanel } = await import("../src/tui/components/dialogs/tasks-panel.ts");
		const panel = new TasksPanel(
			[{ id: "019fe9ffaaaa", backend: "local", state: "completed", elapsedSec: 5 }],
			panelStyles,
			"proj",
		);
		expect(panel.render(120).join("\n")).not.toContain("Experiment status");
	});
});

describe("renderTranscript (transcript re-render)", () => {
	test("user echo, assistant text, tool card pairs with toolResult", () => {
		const messages = [
			msg({ role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 }),
			msg({
				role: "assistant",
				content: [
					{ type: "text", text: "on it" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo ok" } },
				],
				timestamp: 2,
			}),
			msg({ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "ok-output" }], timestamp: 3 }),
		];
		const components = renderTranscript(messages, {
			styles,
			markdownTheme,
			cwd: "/proj",
			isExpanded: () => false,
			requestRender: () => {},
		});
		// One round = RoundSection + a standalone description area (mounted separately, independent)
		expect(components.length).toBe(2);
		const section = components[0];
		expect(section).toBeInstanceOf(RoundSection);
		expect(components[1]).toBe((section as RoundSection).caption);
		const toolCard = (section as RoundSection).card.getChildren().find((c) => c instanceof ToolCallView);
		expect(toolCard).toBeInstanceOf(ToolCallView);
		const rendered = toolCard?.render(80).join("\n") ?? "";
		expect(rendered).toContain("ok-output");
		expect(rendered).toContain("<ok>─ </ok>");
	});

	test("chat-only round replay: the caption is a breathing blank line (no noisy summary)", () => {
		const messages = [
			msg({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }),
			msg({ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 }),
		];
		const components = renderTranscript(messages, {
			styles,
			markdownTheme,
			cwd: "/proj",
			isExpanded: () => false,
			requestRender: () => {},
		});
		expect(components.length).toBe(2);
		const section = components[0] as RoundSection;
		expect(section.caption.render(80)).toEqual([""]);
	});

	test("an orphan toolResult produces no component", () => {
		const messages = [msg({ role: "toolResult", toolCallId: "ghost", content: [], timestamp: 1 })];
		const components = renderTranscript(messages, {
			styles,
			markdownTheme,
			cwd: "/proj",
			isExpanded: () => false,
			requestRender: () => {},
		});
		expect(components.length).toBe(0);
	});
});

describe("SectionCard/SectionCaption (rounded-card transcript)", () => {
	const cardStyles = identityStyles();

	test("rounded border stays within width at any width", () => {
		const card = new SectionCard(cardStyles, "agent");
		card.addChild(new Text("hello kea", 0, 0));
		for (const width of [40, 80, 140]) {
			const lines = card.render(width);
			expect(lines.length, `width=${width}`).toBeGreaterThanOrEqual(3);
			expect(stripTerminalSequences(lines[0] ?? "")).toContain("╭");
			for (const line of lines) {
				expect(visibleWidth(stripTerminalSequences(line)), `width=${width}`).toBeLessThanOrEqual(width);
			}
		}
	});

	test("empty card does not render; content growth shows immediately", () => {
		const card = new SectionCard(cardStyles);
		expect(card.render(80)).toEqual([]);
		// cjk-fixture: fake card content asserted verbatim via toContain
		card.addChild(new Text("一行", 0, 0));
		expect(card.render(80).join("\n")).toContain("一行");
		expect(card.childCount).toBe(1);
	});

	test("flushLeft child uses ├─ branch on first line + blank separator above; normal child gets 1-col padding", () => {
		const card = new SectionCard(cardStyles, "agent");
		// cjk-fixture: fake caption lines located via substring lookups
		card.addChild(new Text("普通内容", 0, 0));
		const flushChild = {
			flushLeft: true,
			render: () => ["─ 读取了 a.py · 10ms", "  后续行"],
			invalidate: () => {},
		};
		card.addChild(flushChild as never);
		const lines = card.render(60);
		const normal = lines.find((l) => l.includes("普通内容")) ?? "";
		const flushIdx = lines.findIndex((l) => l.includes("读取了"));
		const flush = lines[flushIdx] ?? "";
		const rest = lines.find((l) => l.includes("后续行")) ?? "";
		expect(normal.startsWith("│  ")).toBe(true);
		expect(flush.startsWith("├─ ")).toBe(true);
		expect(rest.startsWith("│  ")).toBe(true);
		const above = lines[flushIdx - 1] ?? "";
		expect(above.startsWith("│")).toBe(true);
		expect(above.endsWith("│")).toBe(true);
		expect(above.slice(1, -1).trim()).toBe("");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	test("frame color system: constructor-specified + setFrame recolor + default border fallback", () => {
		const userFrame = (s: string) => `<u>${s}</u>`;
		const accentFrame = (s: string) => `<a>${s}</a>`;
		const errorFrame = (s: string) => `<e>${s}</e>`;

		const userCard = new SectionCard(cardStyles, "user", userFrame);
		userCard.addChild(new Text("hi", 0, 0));
		expect(userCard.render(60).join("")).toContain("<u>╭");

		const agentCard = new SectionCard(cardStyles, "agent", accentFrame);
		agentCard.addChild(new Text("work", 0, 0));
		expect(agentCard.render(60).join("")).toContain("<a>╭");
		agentCard.setFrame(errorFrame);
		const after = agentCard.render(60).join("");
		expect(after).toContain("<e>╭");
		expect(after).not.toContain("<a>╭");

		const plainCard = new SectionCard(cardStyles);
		plainCard.addChild(new Text("x", 0, 0));
		expect(plainCard.render(60)[0]).toContain("╭");
	});

	test("empty text: summary state renders a breathing blank line, live state takes no space", () => {
		const caption = new SectionCaption("", cardStyles);
		expect(caption.render(80)).toEqual([]);
		caption.setSummary("");
		expect(caption.render(80)).toEqual([""]);
	});

	test("action log: pushDone folds the oldest entries past the cap", () => {
		const caption = new SectionCaption("", cardStyles);
		// cjk-fixture: action-log entries asserted verbatim
		for (let i = 0; i < 9; i++) caption.pushDone(`动作${i}`);
		const text = caption.render(120).join("\n");
		expect(text).toContain("…3 more");
		expect(text).toContain("动作8");
		expect(text).not.toContain("动作0");
		expect(text).not.toContain("动作2");
		expect(text).toContain("动作3");
	});

	test("sealed: late events after the summary freeze must not revert to live state", () => {
		const caption = new SectionCaption("", cardStyles);
		// cjk-fixture: caption texts kept as data (frozen-render equality is language-agnostic)
		caption.setLive("正在读取 x");
		caption.setSummary("读取了 1 个文件（2s）");
		const frozen = caption.render(80).join("\n");
		caption.pushDone("迟到的完成句");
		caption.setLive("迟到的 live");
		caption.tick();
		expect(caption.render(80).join("\n")).toBe(frozen);
	});

	test("live long caption wraps to multiple lines width-safely", () => {
		const caption = new SectionCaption("", cardStyles);
		// cjk-fixture: CJK long path exercises width-safe wrapping
		caption.setLive(`正在读取 ${"很长的路径/".repeat(20)}SKILL.md`);
		for (const width of [40, 80, 120]) {
			for (const line of caption.render(width)) {
				expect(visibleWidth(line), `width=${width}`).toBeLessThanOrEqual(width);
			}
		}
	});

	test("caption live → summary switch; live tick drives the spinner; one blank line above and below", () => {
		const caption = new SectionCaption("", styles);
		// cjk-fixture: caption texts asserted verbatim (spinner/switch checks are language-agnostic)
		caption.setLive("思考中…");
		const textOf = (c: SectionCaption) => (c.render(80)[1] ?? "") as string;
		expect(textOf(caption)).toContain("思考中…");
		expect(caption.render(80)[0]).toBe("");
		expect(caption.render(80)[2]).toBe("");
		const before = textOf(caption);
		caption.tick();
		expect(textOf(caption)).not.toBe(before);
		caption.setSummary("3s · 2 工具");
		expect(textOf(caption)).toContain("3s · 2 工具");
		expect(textOf(caption)).not.toContain("✓");
		const summary = textOf(caption);
		caption.tick();
		expect(textOf(caption)).toBe(summary);
	});

	test("history cache: renders share references; tick only changes the live line; pushDone fold recomputes", () => {
		const caption = new SectionCaption("", cardStyles);
		caption.pushDone("read a.py");
		caption.pushDone("write b.py");
		caption.setLive("running command");
		const r1 = caption.render(80);
		expect(r1.length).toBe(5);
		expect(r1[0]).toBe("");
		expect(r1[4]).toBe("");
		const r2 = caption.render(80);
		expect(r2[1]).toBe(r1[1]);
		expect(r2[2]).toBe(r1[2]);
		caption.tick();
		const r3 = caption.render(80);
		expect(r3[1]).toBe(r1[1]);
		expect(r3[2]).toBe(r1[2]);
		expect(r3[3]).not.toBe(r1[3]);
		expect(r3[3]).toContain("running command");
		for (let i = 0; i < 8; i++) caption.pushDone(`action${i}`);
		const r4 = caption.render(80).join("\n");
		expect(r4).toContain("…4 more");
		expect(r4).toContain("action7");
		expect(r4).not.toContain("read a.py");
	});
});

describe("StreamingController (immediate first frame + window throttle)", () => {
	test("first delta flushes immediately, later ones coalesce, flush gets the final text", () => {
		const updates: string[] = [];
		const finals: string[] = [];
		const stub = {
			update: (text: string) => updates.push(text),
			finalize: (text: string) => finals.push(text),
		};
		const controller = new StreamingController(
			() => stub as never,
			() => {},
		);
		controller.onDelta("a");
		controller.onDelta("ab");
		controller.onDelta("abc");
		controller.flush();
		expect(updates[0]).toBe("a");
		expect(updates[updates.length - 1]).toBe("abc");
		controller.onEnd("abcd");
		expect(finals).toEqual(["abcd"]);
		controller.dispose();
	});
});

describe("WelcomeComponent (kimi-style welcome box)", () => {
	const info = { version: "0.1.0", modelSpec: "p/m", sessionId: "abcdef12345678", cwd: "/tmp/proj" };
	// Real ANSI styles: visibleWidth strips escape sequences, so geometry assertions match a real terminal
	const welcomeStyles = ansiStyles();

	test("full-width rounded box + logo beside the title + labeled info line", async () => {
		const { WelcomeComponent } = await import("../src/tui/components/chrome/welcome.ts");
		const lines = new WelcomeComponent(info, welcomeStyles).render(80);
		const text = lines.join("\n");
		expect(lines[0]).toBe("");
		expect(lines[1] ?? "").toContain("╭");
		expect(lines[lines.length - 2] ?? "").toContain("╰");
		expect(lines[lines.length - 1]).toBe("");
		expect(text).toContain("█▄▀ █▀▀ ▄▀█");
		expect(text).toContain("Welcome to Kea!");
		expect(text).toContain("Directory: ");
		expect(text).toContain("/tmp/proj");
		expect(text).toContain("Model: ");
		expect(text).toContain("Version: ");
		const contentLines = lines.filter((l) => l.includes("│"));
		expect(contentLines.length).toBeGreaterThan(4);
		for (const line of [...lines.slice(1, -1)]) {
			expect(stripTerminalSequences(line).startsWith("│") || line.includes("╭") || line.includes("╰")).toBe(true);
			expect(visibleWidth(line)).toBe(80);
		}
	});

	test("narrow terminal degrades to plain text", async () => {
		const { WelcomeComponent } = await import("../src/tui/components/chrome/welcome.ts");
		const lines = new WelcomeComponent(info, welcomeStyles).render(20);
		const text = lines.join("\n");
		expect(text).toContain("Welcome to Kea!");
		expect(text).toContain("Model: p/m");
		expect(text).not.toContain("╭");
	});
});

describe("HelpPanel (kimi editor-replacement paradigm)", () => {
	test("horizontal-rule border + two tables + alias suffixes, Esc closes", async () => {
		const { HelpPanel } = await import("../src/tui/components/dialogs/help-panel.ts");
		let closed = false;
		const panel = new HelpPanel(
			styles,
			// cjk-fixture: fake descriptions located via substring lookups
			[{ name: "app.exit", key: "Ctrl+C ×2", description: "退出" }],
			[
				{ name: "help", aliases: ["h", "?"], description: "命令与快捷键" },
				{ name: "model", description: "切换模型" },
			],
			{ onClose: () => (closed = true) },
		);
		const rendered = panel.render(80).join("\n");
		const plain = rendered.replace(/<[^>]*>/g, "");
		expect(rendered).toContain("─");
		expect(plain).toContain("快捷键");
		expect(plain).toContain("命令");
		expect(plain).toContain("/help (/h, /?)");
		expect(plain).not.toContain("(=");
		panel.handleInput("\x1b");
		expect(closed).toBe(true);
	});

	test("real BUILTIN_COMMANDS: /yolo first, commands ordered by priority", async () => {
		const { HelpPanel } = await import("../src/tui/components/dialogs/help-panel.ts");
		const { BUILTIN_COMMANDS, sortCommands } = await import("../src/tui/commands/registry.ts");
		const panel = new HelpPanel(styles, [], sortCommands(BUILTIN_COMMANDS), { onClose: () => {}, maxVisible: 200 });
		const plain = panel
			.render(120)
			.join("\n")
			.replace(/<[^>]*>/g, "");
		const yoloIdx = plain.indexOf("/yolo");
		const modelIdx = plain.indexOf("/model");
		const exitIdx = plain.indexOf("/exit (/quit, /q)");
		expect(yoloIdx).toBeGreaterThanOrEqual(0);
		expect(modelIdx).toBeGreaterThan(yoloIdx);
		expect(exitIdx).toBeGreaterThan(modelIdx);
		expect(plain).toContain("/settings (/config)");
		expect(plain).not.toContain("[status|check");
	});
});

describe("ghostArgumentHint (command argument ghost hint)", () => {
	test("hint when input is exactly `/cmd `; command names allow hyphens (/export-debug-zip)", async () => {
		const { ghostArgumentHint } = await import("../src/tui/components/editor/rounded-editor.ts");
		const hints = new Map([
			["model", "[provider/model-id | add]"],
			["export-debug-zip", "[out.zip]"],
		]);
		expect(ghostArgumentHint("/model ", hints)).toBe("[provider/model-id | add]");
		expect(ghostArgumentHint("/export-debug-zip ", hints)).toBe("[out.zip]");
		expect(ghostArgumentHint("/model x", hints)).toBeUndefined();
		expect(ghostArgumentHint("/nope ", hints)).toBeUndefined();
		expect(ghostArgumentHint("model ", hints)).toBeUndefined();
	});
});

describe("highlightFirstSlashToken (slash highlighting)", () => {
	test("/token after the prompt is highlighted; skipped when cursor reverse-video is present", async () => {
		const { highlightFirstSlashToken } = await import("../src/tui/components/editor/rounded-editor.ts");
		const paint = (s: string) => `<hl>${s}</hl>`;
		expect(highlightFirstSlashToken("  > /model anthropic/x", paint)).toBe("  > <hl>/model</hl> anthropic/x");
		expect(highlightFirstSlashToken("  > hello", paint)).toBeUndefined();
		expect(highlightFirstSlashToken("  > \x1b[7m/\x1b[0mmodel", paint)).toBeUndefined();
	});
});

describe("wrapWithSideBorders (rounded input box)", () => {
	const paint = (s: string) => `<b>${s}</b>`;

	test("horizontal-rule border becomes a rounded box", () => {
		const out = wrapWithSideBorders(["──────", " text ", "──────"], paint);
		expect(out[0]).toBe("<b>╭────╮</b>");
		expect(out[2]).toBe("<b>╰────╯</b>");
	});

	test("content lines get │ vertical borders on both sides (width preserved)", () => {
		const out = wrapWithSideBorders(["──────", " text ", "──────"], paint);
		expect(out[1]).toBe("<b>│</b>text<b>│</b>");
	});

	test("non-space at end of line is not overwritten (protects cursor reverse-video)", () => {
		const out = wrapWithSideBorders(["─", " x█"], paint);
		expect(out[0]).toBe("<b>╭</b>");
		expect(out[1]).toBe("<b>│</b>x█");
	});
});

describe("injectPromptSymbol (editor prompt symbol)", () => {
	test("injects the > prompt into 4 leading blank columns", () => {
		expect(injectPromptSymbol("    hello")).toBe("  > hello");
		expect(injectPromptSymbol("    ")).toBe("  > ");
	});

	test("no injection when the line starts with non-space (paste marker/cursor cases)", () => {
		expect(injectPromptSymbol("x   hello")).toBeUndefined();
		expect(injectPromptSymbol("  x")).toBeUndefined();
	});
});

describe("SlashAwareAutocomplete (alias resolves to the primary command)", () => {
	const mk = async () => {
		const { SlashAwareAutocomplete } = await import("../src/tui/components/editor/slash-provider.ts");
		const { BUILTIN_COMMANDS } = await import("../src/tui/commands/registry.ts");
		return new SlashAwareAutocomplete(BUILTIN_COMMANDS as never, "/tmp");
	};
	const signal = new AbortController().signal;

	test("bare / lists all primary commands, no alias entries", async () => {
		const provider = await mk();
		const res = await provider.getSuggestions(["/"], 0, 1, { signal });
		expect(res).not.toBeNull();
		const values = res?.items.map((i) => i.value) ?? [];
		expect(values).toContain("exit");
		expect(values.some((v) => v === "quit" || v === "h" || v === "yes")).toBe(false);
	});

	test("typing the alias /quit resolves to primary /exit", async () => {
		const provider = await mk();
		const res = await provider.getSuggestions(["/quit"], 0, 5, { signal });
		expect(res?.items.map((i) => i.value)).toContain("exit");
		const applied = provider.applyCompletion(["/quit"], 0, 5, { value: "exit", label: "exit" }, "/quit");
		expect(applied.lines[0]).toBe("/exit ");
	});

	test("alias-hit label carries all aliases (kimi shape `exit (quit, q)`)", async () => {
		const provider = await mk();
		const res = await provider.getSuggestions(["/qui"], 0, 4, { signal });
		const exitItem = res?.items.find((i) => i.value === "exit");
		expect(exitItem?.label).toBe("exit (quit, q)");
	});

	test("primary-name hit label has no alias suffix", async () => {
		const provider = await mk();
		const res = await provider.getSuggestions(["/exit"], 0, 5, { signal });
		expect(res?.items.find((i) => i.value === "exit")?.label).toBe("exit");
	});

	test("case-insensitive: /YOLO argument completion and /MOBAI subcommand completion both work", async () => {
		const provider = await mk();
		const yoloRes = await provider.getSuggestions(["/YOLO o"], 0, 7, { signal });
		expect(yoloRes?.items.map((i) => i.value)).toContain("on");
		const mobaiRes = await provider.getSuggestions(["/MOBAI next l"], 0, 12, { signal });
		expect(mobaiRes?.items.map((i) => i.value)).toContain("list");
	});

	test("completion works after an alias too (/yes o → on/off)", async () => {
		const provider = await mk();
		const res = await provider.getSuggestions(["/yes o"], 0, 6, { signal });
		const values = res?.items.map((i) => i.value) ?? [];
		expect(values).toContain("on");
	});

	test("@ file completion keeps the @ shape (regression: stray / prefix)", async () => {
		const provider = await mk();
		const applied = provider.applyCompletion(["look at @sr"], 0, 11, { value: "@src/foo.ts", label: "foo.ts" }, "@sr");
		expect(applied.lines[0]).toBe("look at @src/foo.ts ");
		expect(applied.lines[0]).not.toContain("look at /");
	});

	test("command argument completion keeps the command prefix (delegates to fallback)", async () => {
		const provider = await mk();
		const applied = provider.applyCompletion(["/yes o"], 0, 6, { value: "on", label: "on" }, "o");
		expect(applied.lines[0]).toBe("/yes on");
	});

	test("slash menu only on line 0 and not forced (multiline draft / Tab file completion does not pop it)", async () => {
		const provider = await mk();
		expect(await provider.getSuggestions(["note", "/go"], 1, 3, { signal })).toBeNull();
		expect(await provider.getSuggestions(["/go"], 0, 3, { signal, force: true })).toBeNull();
	});

	test("shouldTriggerFileCompletion delegates to fallback: slash names do not trigger file completion", async () => {
		const provider = await mk();
		expect(provider.shouldTriggerFileCompletion(["/go"], 0, 3)).toBe(false);
	});
});

describe("classifyError (error friendliness)", () => {
	test("classifies credentials/rate-limit/network, passes the rest through unchanged", () => {
		expect(classifyError("HTTP 401 Unauthorized")).toContain("/doctor");
		expect(classifyError("429 rate limit exceeded")).toContain("rate-limited");
		expect(classifyError("connect ECONNREFUSED 10.0.0.1:443")).toContain("network/backend unreachable");
		expect(classifyError("weird failure")).toBe("weird failure");
	});
});

describe("InfoPanel (modern key handling)", () => {
	const make = () => {
		let closed = false;
		const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
		const panel = new InfoPanel(
			styles,
			"Environment health check",
			lines,
			() => {
				closed = true;
			},
			10,
		);
		return { panel, isClosed: () => closed };
	};

	test("↓ one line / PgDn one page / G·end to bottom / g·home to top", () => {
		const { panel } = make();
		panel.handleInput("\x1b[B");
		expect(panel.render(80).join("\n")).toContain("line-1");
		panel.handleInput("\x1b[6~");
		expect(panel.render(80).join("\n")).toContain("line-11");
		panel.handleInput("G");
		expect(panel.render(80).join("\n")).toContain("line-39");
		panel.handleInput("g");
		expect(panel.render(80).join("\n")).toContain("line-0");
		panel.handleInput("\x1b[5~");
		expect(panel.render(80).join("\n")).toContain("line-0");
	});

	test("q / Esc / Enter close", () => {
		for (const key of ["q", "\x1b", "\r"]) {
			const { panel, isClosed } = make();
			panel.handleInput(key);
			expect(isClosed(), `key=${JSON.stringify(key)}`).toBe(true);
		}
	});
});

describe("TrustPrompt (untrusted-folder prompt)", () => {
	const tpStyles = identityStyles();

	test("renders title/dir/gating note/two options, width-safe", async () => {
		const { TrustPrompt } = await import("../src/tui/components/dialogs/trust-prompt.ts");
		const prompt = new TrustPrompt({ workDir: "/tmp/proj", gatedMcpServers: ["mp"], onSelect: () => {} }, tpStyles);
		for (const width of [40, 80, 120]) {
			const text = prompt.render(width).join("\n");
			expect(text).toContain("Trust this folder?");
			expect(text).toContain("/tmp/proj");
			expect(text).toContain("mp");
			expect(text).toContain("Don't trust");
		}
		for (const width of [40, 80, 120]) {
			for (const line of prompt.render(width)) {
				expect(visibleWidth(line), `width=${width}`).toBeLessThanOrEqual(width);
			}
		}
	});

	test("Enter selects the current item; ↓ switches; Esc = distrust", async () => {
		const { TrustPrompt } = await import("../src/tui/components/dialogs/trust-prompt.ts");
		const choices: string[] = [];
		const prompt = new TrustPrompt(
			{ workDir: "/tmp/proj", gatedMcpServers: [], onSelect: (c) => choices.push(c) },
			tpStyles,
		);
		prompt.handleInput("\r");
		expect(choices).toEqual(["trust"]);
		prompt.handleInput("\x1b[B");
		prompt.handleInput("\r");
		expect(choices).toEqual(["trust", "distrust"]);
		prompt.handleInput("\x1b");
		expect(choices).toEqual(["trust", "distrust", "distrust"]);
	});
});
