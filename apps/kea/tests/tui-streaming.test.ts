import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { type KernelEvent, KernelEventBus } from "@kea/core";
import { describe, expect, test, vi } from "vitest";
import { RoundedEditor } from "../src/tui/components/editor/rounded-editor.ts";
import { AssistantMessageView } from "../src/tui/components/messages/assistant-message.ts";
import { RoundSection } from "../src/tui/components/messages/round-section.ts";
import { classifyError } from "../src/tui/controllers/error-classify.ts";
import { subscribeKernelEvents } from "../src/tui/controllers/kernel-event-handler.ts";
import { StreamingController, ToolUpdateCoalescer } from "../src/tui/controllers/streaming-ui.ts";
import { createTUIState } from "../src/tui/state.ts";
import { identityMarkdownTheme, identityStyles, tagStyles } from "./helpers/styles.ts";

const styles = identityStyles();

const mdTheme = identityMarkdownTheme();

function makeFakeCtx() {
	const state = createTUIState();
	const events = new KernelEventBus();
	const tracked: unknown[] = [];
	const statuses: string[] = [];
	const ctx = {
		tui: { requestRender: () => {} },
		editor: { getText: () => "", setText: () => {} },
		state,
		kernel: { events, agent: { state: { isStreaming: false, messages: [] } }, abort: () => {}, todos: [] },
		footer: {},
		todoPanel: { setTodos: () => {}, clear: () => {}, hasOverflow: () => false, toggleExpanded: () => {} },
		notifier: { notify: () => {} },
		styles: () => styles,
		markdownTheme: () => mdTheme,
		addText: () => {},
		trimTranscriptWindow: () => {},
		showStatus: (text: string) => statuses.push(text),
		showError: () => {},
		mountDialog: () => {},
		restoreEditor: () => {},
		trackComponent: (c: unknown) => tracked.push(c),
		clearTranscript: () => {},
		refreshFooter: () => {},
		armExitHint: () => {},
		resolveApproval: () => {},
		summarizeTurn: async () => undefined,
		exit: () => {},
	};
	return { ctx: ctx as never, events, tracked, statuses, state };
}

describe("streaming render event pipeline (regression: object-reference comparison bug)", () => {
	test("message_start→delta→end: content reaches the screen", () => {
		const { ctx, events, tracked } = makeFakeCtx();
		subscribeKernelEvents(ctx);

		const makeMessage = () => ({ role: "assistant", content: [], timestamp: Date.now() });
		events.emit({ type: "message_start", message: makeMessage() } as KernelEvent);
		// cjk-fixture: streamed text is test data asserted verbatim
		events.emit({ type: "message_delta", message: makeMessage(), text: "你好" } as KernelEvent);
		events.emit({ type: "message_delta", message: makeMessage(), text: "你好！我是 Kea" } as KernelEvent);
		events.emit({ type: "message_end", message: makeMessage(), text: "你好！我是 Kea" } as KernelEvent);

		const section = tracked.find((c): c is RoundSection => c instanceof RoundSection);
		expect(section).toBeDefined();
		const view = section?.card.getChildren().find((c): c is AssistantMessageView => c instanceof AssistantMessageView);
		expect(view).toBeDefined();
		const rendered = view?.render(80).join("\n") ?? "";
		expect(rendered).toContain("你好！我是 Kea");
		expect(rendered.startsWith("─ ")).toBe(true);
	});

	test("paired empty message_start produces no duplicate thinking block (lazy-mount regression)", async () => {
		const { ThinkingView } = await import("../src/tui/components/messages/thinking.ts");
		const { ctx, events, tracked } = makeFakeCtx();
		subscribeKernelEvents(ctx);

		const makeMessage = () => ({ role: "assistant", content: [], timestamp: Date.now() });
		events.emit({ type: "message_start", message: makeMessage() } as KernelEvent);
		events.emit({ type: "message_end", message: makeMessage(), text: "" } as KernelEvent);
		events.emit({ type: "message_start", message: makeMessage() } as KernelEvent);
		events.emit({ type: "message_delta", message: makeMessage(), text: "", thinking: "让我想想" } as KernelEvent);

		expect(tracked.filter((c) => c instanceof RoundSection)).toHaveLength(1);
		const children = tracked.flatMap((c) => (c instanceof RoundSection ? [...c.card.getChildren()] : []));
		expect(children.filter((c) => c instanceof ThinkingView)).toHaveLength(1);
		expect(children.filter((c) => c instanceof AssistantMessageView)).toHaveLength(1);
	});

	test("chat-only round: caption has no boilerplate noise, round ends with a breathing blank line", () => {
		const { ctx, events, tracked } = makeFakeCtx();
		subscribeKernelEvents(ctx);
		const makeMessage = () => ({ role: "assistant", content: [], timestamp: Date.now() });
		events.emit({ type: "message_start", message: makeMessage() } as KernelEvent);
		// cjk-fixture: streamed text asserted verbatim
		events.emit({ type: "message_delta", message: makeMessage(), text: "你好" } as KernelEvent);
		events.emit({ type: "message_end", message: makeMessage(), text: "你好" } as KernelEvent);
		events.emit({ type: "run_end", runId: "r1", outcome: "completed" } as KernelEvent);
		const section = tracked.find((c): c is RoundSection => c instanceof RoundSection);
		expect(section).toBeDefined();
		expect(section?.caption.render(80)).toEqual([""]);
	});

	test("model_retry event shows a retry hint", () => {
		const { ctx, events, statuses } = makeFakeCtx();
		subscribeKernelEvents(ctx);
		events.emit({
			type: "model_retry",
			attempt: 1,
			maxAttempts: 10,
			delayMs: 500,
			errorMessage: "Connection error.",
		} as KernelEvent);
		expect(statuses.some((s) => s.includes("auto-retrying 1/10"))).toBe(true);
	});
});

describe("error classification", () => {
	test("unconfigured provider gives credential guidance", () => {
		expect(classifyError("Provider is not configured: qwen-token-plan")).toContain(
			"provider credentials not configured",
		);
		expect(classifyError("Provider is not configured: qwen-token-plan")).toContain("/doctor");
	});
});

describe("StreamingController (regression: previous message's thinking leaks into next first flush)", () => {
	function makeRecorder() {
		const updates: Array<{ text: string; thinking?: string }> = [];
		const finalized: string[] = [];
		const view = {
			update: (text: string, thinking?: string) => updates.push({ text, thinking }),
			finalize: (text: string) => finalized.push(text),
		} as never;
		return { updates, finalized, view };
	}

	test("pending resets after onEnd: the next message's first flush carries no stale thinking/text", () => {
		const { updates, finalized, view } = makeRecorder();
		const sc = new StreamingController(
			() => view,
			() => {},
		);

		sc.onDelta("hello", "thinking-A");
		sc.flush();
		sc.onEnd("hello");
		expect(finalized).toEqual(["hello"]);

		sc.onDelta("world");
		sc.flush();
		const last = updates[updates.length - 1];
		expect(last?.text).toBe("world");
		expect(last?.thinking).toBeUndefined();
		sc.dispose();
	});

	test("onEnd clears pendingText: an empty delta's first flush does not replay the previous body", () => {
		const { updates, view } = makeRecorder();
		const sc = new StreamingController(
			() => view,
			() => {},
		);
		sc.onDelta("prev text");
		sc.flush();
		sc.onEnd("prev text");
		sc.onDelta("");
		sc.flush();
		expect(updates[updates.length - 1]?.text).toBe("");
		sc.dispose();
	});

	test("dispose clears pending: an interrupted run's thinking never reaches the next message's first flush", () => {
		const { updates, view } = makeRecorder();
		const sc = new StreamingController(
			() => view,
			() => {},
		);

		sc.onDelta("partial", "thinking-A");
		sc.dispose();

		sc.onDelta("fresh");
		sc.flush();
		const last = updates[updates.length - 1];
		expect(last?.text).toBe("fresh");
		expect(last?.thinking).toBeUndefined();
	});

	test("dispose clears pendingText: after interruption an empty delta's first flush does not replay the body", () => {
		const { updates, view } = makeRecorder();
		const sc = new StreamingController(
			() => view,
			() => {},
		);
		sc.onDelta("prev text");
		sc.dispose();
		sc.onDelta("");
		sc.flush();
		expect(updates[updates.length - 1]?.text).toBe("");
	});
});

describe("RoundedEditor ghost hint (regression: over-wide crash)", () => {
	const id = (s: string) => s;
	const editorStyles = identityStyles();

	test("argument hint never exceeds the terminal width (any width)", () => {
		const fakeTui = { requestRender: () => {}, terminal: { rows: 40, columns: 160 } } as never;
		const editor = new RoundedEditor(
			fakeTui,
			{
				borderColor: id,
				selectList: { selectedPrefix: id, selectedText: id, description: id, scrollInfo: id, noMatch: id },
			},
			undefined,
			{ styles: editorStyles, argumentHints: new Map([["mobai", "[status]"]]) },
		);
		editor.setText("/mobai ");
		for (const width of [40, 80, 140, 160]) {
			for (const line of editor.render(width)) {
				expect(visibleWidth(stripTerminalSequences(line)), `width=${width}`).toBeLessThanOrEqual(width);
			}
			expect(editor.render(width).join("\n")).toContain("[status]");
		}
	});
});

describe("ApprovalPanel content preview (kimi diff-preview paradigm)", () => {
	const panelStyles = tagStyles({ dim: "d", faint: "f", success: "ok", error: "e", bold: "b" });

	test("edit approval shows the -/+ diff preview", async () => {
		const { ApprovalPanel } = await import("../src/tui/components/dialogs/approval-panel.ts");
		const panel = new ApprovalPanel({
			toolName: "edit",
			path: "src/x.ts",
			preview: ["<e>- old line</e>", "<ok>+ new line</ok>"],
			styles: panelStyles,
		});
		const rendered = panel.render(80).join("\n");
		expect(rendered).toContain("Edit this file?");
		expect(rendered).toContain("- old line");
		expect(rendered).toContain("+ new line");
		expect(rendered).toContain("src/x.ts");
	});

	test("preview past the cap folds and reports the remaining line count", async () => {
		const { ApprovalPanel } = await import("../src/tui/components/dialogs/approval-panel.ts");
		const preview = Array.from({ length: 20 }, (_, i) => `line ${i}`);
		const panel = new ApprovalPanel({ toolName: "write", path: "a.txt", preview, styles: panelStyles });
		const rendered = panel.render(80).join("\n");
		expect(rendered).toContain("line 11");
		expect(rendered).not.toContain("line 12");
		expect(rendered).toContain("(8 more lines)");
	});
});

describe("width safety (guards the pi-tui over-wide crash)", () => {
	const safeStyles = identityStyles();

	test("StatusMessage overlong single line stays within width", async () => {
		const { StatusMessage } = await import("../src/tui/components/messages/status-message.ts");
		// cjk-fixture: CJK status text exercises width-safe non-ASCII wrapping
		const msg = new StatusMessage("x".repeat(500) + "这是一个超长的中文状态".repeat(20), safeStyles, "error");
		for (const line of msg.render(80)) {
			expect(line.length).toBeLessThanOrEqual(80);
		}
	});

	test("ApprovalPanel overlong command stays within width", async () => {
		const { ApprovalPanel } = await import("../src/tui/components/dialogs/approval-panel.ts");
		const panel = new ApprovalPanel({
			toolName: "bash",
			command: `rm ${"-very-long-flag ".repeat(50)}`,
			styles: safeStyles,
		});
		for (const line of panel.render(60)) {
			expect(visibleWidth(stripTerminalSequences(line))).toBeLessThanOrEqual(60);
		}
	});
});

describe("approval fullscreen preview (Ctrl+E, kimi approval-preview paradigm)", () => {
	const previewStyles = identityStyles();
	const manyLines = Array.from({ length: 100 }, (_, i) => `line-${i} ${"x".repeat(30)}`);

	test("renders width-safe at any width with height = rows", async () => {
		const { ApprovalPreviewViewer } = await import("../src/tui/components/dialogs/approval-preview.ts");
		const viewer = new ApprovalPreviewViewer({
			title: "/tmp/foo.py",
			lines: manyLines,
			rows: 24,
			styles: previewStyles,
			onClose: () => {},
		});
		for (const width of [40, 80, 140]) {
			const rendered = viewer.render(width);
			expect(rendered, `width=${width}`).toHaveLength(24);
			for (const line of rendered) {
				expect(visibleWidth(stripTerminalSequences(line)), `width=${width}`).toBeLessThanOrEqual(width);
			}
		}
	});

	test("scrolling: j/k, PgDn, g/G boundaries", async () => {
		const { ApprovalPreviewViewer } = await import("../src/tui/components/dialogs/approval-preview.ts");
		const viewer = new ApprovalPreviewViewer({
			title: "t",
			lines: manyLines,
			rows: 10,
			styles: previewStyles,
			onClose: () => {},
		});
		expect(viewer.render(80).join("\n")).toContain("line-0");
		viewer.handleInput("j");
		expect(viewer.render(80).join("\n")).not.toContain("line-0 ");
		viewer.handleInput("G");
		expect(viewer.render(80).join("\n")).toContain("line-99");
		viewer.handleInput("g");
		expect(viewer.render(80).join("\n")).toContain("line-0");
		viewer.handleInput("\x1b[6~");
		expect(viewer.render(80).join("\n")).toContain("line-5");
	});

	test("Q/Esc/Ctrl+E all close", async () => {
		const { ApprovalPreviewViewer } = await import("../src/tui/components/dialogs/approval-preview.ts");
		for (const key of ["q", "\x1b", "\u0005"]) {
			let closed = false;
			const viewer = new ApprovalPreviewViewer({
				title: "t",
				lines: manyLines,
				rows: 10,
				styles: previewStyles,
				onClose: () => {
					closed = true;
				},
			});
			viewer.handleInput(key);
			expect(closed, `key=${JSON.stringify(key)}`).toBe(true);
		}
	});

	test("ApprovalPanel: with a preview shows the Ctrl+E hint, the key triggers onPreview", async () => {
		const { ApprovalPanel } = await import("../src/tui/components/dialogs/approval-panel.ts");
		let previewed = false;
		const panel = new ApprovalPanel({
			toolName: "edit",
			path: "/tmp/a.py",
			preview: ["- old", "+ new"],
			styles: previewStyles,
		});
		panel.onPreview = () => {
			previewed = true;
		};
		expect(panel.render(80).join("\n")).toContain("Ctrl+E preview");
		panel.handleInput("\u0005");
		expect(previewed).toBe(true);
		let decided = "";
		panel.onDecision = (d) => {
			decided = d.kind;
		};
		panel.handleInput("2");
		expect(decided).toBe("approve-session");
	});

	test("ApprovalPanel: without onPreview, Ctrl+E is silently ignored", async () => {
		const { ApprovalPanel } = await import("../src/tui/components/dialogs/approval-panel.ts");
		const panel = new ApprovalPanel({
			toolName: "bash",
			command: "ls",
			styles: previewStyles,
		});
		expect(() => panel.handleInput("\u0005")).not.toThrow();
		expect(panel.render(80).join("\n")).not.toContain("Ctrl+E preview");
	});
});

describe("WidthSafe (global over-wide guard)", () => {
	test("any component's over-wide lines are truncated to the render width", async () => {
		const { WidthSafe } = await import("../src/tui/components/width-safe.ts");
		const bad = {
			invalidate: () => {},
			render: () => ["x".repeat(500), "y".repeat(300)],
		};
		const safe = new WidthSafe(bad as never);
		for (const line of safe.render(80)) {
			// pi-tui only cares about visual width (raw length includes ANSI escapes and ellipsis)
			expect(visibleWidth(stripTerminalSequences(line))).toBeLessThanOrEqual(80);
		}
	});

	test("memo: same input ref + same width → same output ref; changes recompute; lines still truncated", async () => {
		const { WidthSafe } = await import("../src/tui/components/width-safe.ts");
		let current = ["x".repeat(500), "short"];
		const inner = {
			invalidate: () => {},
			render: () => current,
		};
		const safe = new WidthSafe(inner as never);
		const a1 = safe.render(80);
		const a2 = safe.render(80);
		expect(a2).toBe(a1);
		for (const line of a1) expect(visibleWidth(stripTerminalSequences(line))).toBeLessThanOrEqual(80);
		current = ["y".repeat(500)];
		const b1 = safe.render(80);
		expect(b1).not.toBe(a1);
		expect(visibleWidth(stripTerminalSequences(b1[0] ?? ""))).toBeLessThanOrEqual(80);
		const c1 = safe.render(40);
		expect(c1).not.toBe(b1);
		expect(visibleWidth(stripTerminalSequences(c1[0] ?? ""))).toBeLessThanOrEqual(40);
		safe.invalidate();
		const d1 = safe.render(40);
		expect(d1).not.toBe(c1);
		expect(visibleWidth(stripTerminalSequences(d1[0] ?? ""))).toBeLessThanOrEqual(40);
	});
});

describe("ToolCallView overlong content stays within width (crash regression)", () => {
	const safeStyles = identityStyles();

	test("running overlong bash command wraps within width", async () => {
		const { ToolCallView } = await import("../src/tui/components/messages/tool-call.ts");
		const longCmd = `cd /very/long/path && ${"echo some-arg ".repeat(30)}`;
		const view = new ToolCallView({
			name: "bash",
			args: { command: longCmd },
			cwd: "/proj",
			styles: safeStyles,
			isExpanded: () => false,
			requestRender: () => {},
		});
		for (const width of [60, 100, 142]) {
			for (const line of view.render(width)) {
				expect(visibleWidth(stripTerminalSequences(line)), `width=${width}`).toBeLessThanOrEqual(width);
			}
		}
	});

	test("finished overlong header (long path + many chips) stays within width", async () => {
		const { ToolCallView } = await import("../src/tui/components/messages/tool-call.ts");
		const view = new ToolCallView({
			name: "read",
			args: { path: "a/very/long/nested/path/to/some/deeply/nested/file/that/goes/on/forever.ts" },
			cwd: "/x",
			styles: safeStyles,
			isExpanded: () => false,
			requestRender: () => {},
		});
		view.finish({ durationMs: 123456, preview: "line\n".repeat(50), isError: false });
		for (const width of [60, 100, 142]) {
			for (const line of view.render(width)) {
				expect(visibleWidth(stripTerminalSequences(line)), `width=${width}`).toBeLessThanOrEqual(width);
			}
		}
	});
});

describe("tool_update render coalescing (50ms window + immediate first leading edge)", () => {
	function makeCountingCtx() {
		const { ctx, events, state, tracked } = makeFakeCtx();
		let renderCount = 0;
		(ctx as { tui: { requestRender: () => void } }).tui.requestRender = () => {
			renderCount += 1;
		};
		return { ctx, events, state, tracked, renders: () => renderCount };
	}
	const partial = (text: string) =>
		({
			type: "tool_update",
			toolCallId: "t1",
			partial: { content: [{ type: "text", text }] },
		}) as KernelEvent;

	test("ToolUpdateCoalescer: first leading edge lands immediately, window merges by id, flush applies at once", () => {
		vi.useFakeTimers();
		try {
			const applied: string[] = [];
			let renders = 0;
			const fakeView = { appendLiveText: (t: string) => applied.push(t) } as never;
			const coalescer = new ToolUpdateCoalescer(
				() => fakeView,
				() => {
					renders += 1;
				},
			);
			coalescer.onUpdate("t1", "a");
			expect(applied).toEqual(["a"]);
			expect(renders).toBe(1);
			coalescer.onUpdate("t1", "b");
			coalescer.onUpdate("t2", "c");
			expect(applied).toEqual(["a"]);
			expect(renders).toBe(1);
			coalescer.flush();
			expect(applied).toEqual(["a", "b", "c"]);
			expect(renders).toBe(2);
			// An empty flush triggers no extra render (quiet when the tool_end pre-flush has nothing pending)
			coalescer.flush();
			expect(renders).toBe(2);
			coalescer.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("ToolUpdateCoalescer: late partial (view already removed) is silently dropped, no empty render", () => {
		vi.useFakeTimers();
		try {
			let renders = 0;
			const coalescer = new ToolUpdateCoalescer(
				() => undefined,
				() => {
					renders += 1;
				},
			);
			coalescer.onUpdate("gone", "x");
			expect(renders).toBe(0);
			coalescer.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("event pipeline: first partial renders immediately, bursts coalesce into one trailing render (no loss)", () => {
		vi.useFakeTimers();
		try {
			const { ctx, events, state, renders } = makeCountingCtx();
			subscribeKernelEvents(ctx);
			events.emit({
				type: "tool_start",
				toolCallId: "t1",
				name: "bash",
				args: { command: "seq 9" },
			} as KernelEvent);
			const view = state.toolViews.get("t1");
			expect(view).toBeDefined();
			const afterStart = renders();

			events.emit(partial("chunk-a\n"));
			expect(renders()).toBe(afterStart + 1);
			expect(view?.render(80).join("\n")).toContain("chunk-a");

			events.emit(partial("chunk-b\n"));
			events.emit(partial("chunk-c\n"));
			expect(renders()).toBe(afterStart + 1);
			expect(view?.render(80).join("\n")).not.toContain("chunk-c");

			vi.advanceTimersByTime(50);
			expect(renders()).toBe(afterStart + 2);
			expect(view?.render(80).join("\n")).toContain("chunk-c");
		} finally {
			vi.useRealTimers();
		}
	});

	test("tool_end pre-flush: pending partials land in the buffer before finish (render count pins the wiring)", () => {
		vi.useFakeTimers();
		try {
			const { ctx, events, state, renders } = makeCountingCtx();
			subscribeKernelEvents(ctx);
			events.emit({
				type: "tool_start",
				toolCallId: "t1",
				name: "bash",
				args: { command: "seq 9" },
			} as KernelEvent);
			const afterStart = renders();
			events.emit(partial("chunk-a\n"));
			events.emit(partial("chunk-b\n"));
			expect(renders()).toBe(afterStart + 1);

			events.emit({
				type: "tool_end",
				toolCallId: "t1",
				name: "bash",
				isError: false,
				durationMs: 5,
				resultPreview: "ok",
			} as KernelEvent);
			// flush(+1) + finish's view.requestRender(+1) + handler teardown requestRender(+1)
			expect(renders()).toBe(afterStart + 4);
			expect(state.toolViews.has("t1")).toBe(false);
			expect(state.sectionParts).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("session_switched resets session state (regression: steer queue/last reply leaked across sessions)", () => {
	test("switching sessions clears steerQueue / lastAssistant (approval grants cleared by the kernel on switch)", () => {
		const { ctx, events, state } = makeFakeCtx();
		subscribeKernelEvents(ctx);
		state.steerQueue.push("leftover steer");
		state.lastAssistant = "old session reply";
		events.emit({ type: "session_switched", sessionId: "newsession" } as KernelEvent);
		expect(state.steerQueue.length).toBe(0);
		expect(state.lastAssistant).toBe("");
	});

	test("switching sessions clears toolMeta / streaming / in-flight compaction view (leftover-leak regression)", () => {
		const { ctx, events, state, tracked } = makeFakeCtx();
		subscribeKernelEvents(ctx);
		state.streaming = { update: () => {}, finalize: () => {} } as never;
		state.streamingMessage = {} as never;
		events.emit({ type: "compaction_started" } as KernelEvent);
		const compaction = tracked[tracked.length - 1] as { render: (w: number) => string[] };
		events.emit({ type: "tool_start", toolCallId: "t1", name: "bash", args: { command: "echo stale" } } as KernelEvent);
		expect(state.sectionParts.length).toBe(0);

		events.emit({ type: "session_switched", sessionId: "s2" } as KernelEvent);
		expect(state.streaming).toBeUndefined();
		expect(state.streamingMessage).toBeUndefined();
		// The compaction view is frozen as failed rather than spinning forever
		expect(compaction.render(80).join("")).toContain("compaction failed");

		// Late tool_end: old meta already cleared → anonymous events must not enter round stats (no empty name/stale args caption)
		events.emit({
			type: "tool_end",
			toolCallId: "t1",
			name: "bash",
			isError: false,
			durationMs: 5,
			resultPreview: "ok",
		} as KernelEvent);
		expect(state.sectionParts.length).toBe(0);
	});
});

describe("dialog width safety (regression: pi-tui hard-crashes on over-wide lines)", () => {
	// dialog mounts onto a bare Container (editorSlot) with no width guard, so every rendered line must be ≤ width
	const dialogStyles = identityStyles();
	const widths = [40, 60, 80];
	const assertFits = (lines: string[], width: number) => {
		for (const line of lines) {
			expect(visibleWidth(stripTerminalSequences(line)), `width=${width}`).toBeLessThanOrEqual(width);
		}
	};

	test("PromptStep: 200-char input scrolls horizontally within width, cursor stays visible", async () => {
		const { PromptStep } = await import("../src/tui/prompt-input.ts");
		const step = new PromptStep(
			{ question: "API endpoint?", placeholder: "https://..." },
			{ onSubmit: () => {}, onCancel: () => {} },
		);
		step.handleInput(`https://api.example.com/v1/${"x".repeat(173)}`);
		step.focused = true;
		for (const width of widths) assertFits(step.render(width), width);
		const inputLine = stripTerminalSequences(step.render(40)[1] ?? "").trimEnd();
		expect(inputLine.endsWith("xxxx")).toBe(true);
		expect(inputLine).not.toContain("https://");
	});

	test("TasksPanel: header/empty state/awaiting warning stay within width", async () => {
		const { TasksPanel } = await import("../src/tui/components/dialogs/tasks-panel.ts");
		const cwdLabel = "~/Code/artist-mobai/team/mobai-research/Kea/Kea-2";
		const rows = [
			{
				id: "job-aaaabbbb",
				backend: "local",
				state: "awaiting_human",
				elapsedSec: 12,
				label: "supercongruence sweep over p=1..9",
			},
			{ id: "job-ccccdddd", backend: "slurm", state: "running", elapsedSec: 345 },
		];
		const stats = [
			{
				name: "supercongruence",
				version: 3,
				metric: "score",
				direction: "maximize",
				runs: 4,
				best: 0.91,
				trend: "▁▂▃▅",
			},
		];
		const panel = new TasksPanel(rows, dialogStyles, cwdLabel, stats);
		for (const width of widths) assertFits(panel.render(width), width);
		const empty = new TasksPanel([], dialogStyles, cwdLabel);
		for (const width of widths) assertFits(empty.render(width), width);
	});

	test("InfoPanel: title line and scroll-count line stay within width", async () => {
		const { InfoPanel } = await import("../src/tui/components/dialogs/info-panel.ts");
		const panel = new InfoPanel(
			dialogStyles,
			`keybindings — ${"a very long section title ".repeat(3)}`,
			Array.from({ length: 30 }, (_, i) => `line ${i} ${"y".repeat(60)}`),
			() => {},
			5,
		);
		for (const width of widths) assertFits(panel.render(width), width);
	});

	test("ApprovalPanel: every line of deny-feedback mode stays within width", async () => {
		const { ApprovalPanel } = await import("../src/tui/components/dialogs/approval-panel.ts");
		const panel = new ApprovalPanel({
			toolName: "bash",
			command: `find /very/deep/nested/path -name "*.ts" | xargs grep -n "some-pattern"`,
			path: "/very/deep/nested/path",
			danger: "Wide-open permissions",
			preview: ["- old line", "+ new line"],
			styles: dialogStyles,
		});
		panel.handleInput("4");
		panel.focused = true;
		for (const width of widths) assertFits(panel.render(width), width);
	});

	test("ApprovalPanel: width 6/8 selection and feedback modes stay within width (crash regression)", async () => {
		const { ApprovalPanel } = await import("../src/tui/components/dialogs/approval-panel.ts");
		const narrow = [6, 8];
		const panel = new ApprovalPanel({
			toolName: "bash",
			command: `sudo ${"rm -rf ".repeat(10)}/`,
			path: "/very/deep/nested/path/to/file.txt",
			danger: "Privilege escalation",
			preview: Array.from({ length: 30 }, (_, i) => `preview line ${i} ${"x".repeat(40)}`),
			styles: dialogStyles,
		});
		for (const width of narrow) assertFits(panel.render(width), width);
		panel.handleInput("4");
		panel.focused = true;
		for (const ch of "some denial reason") panel.handleInput(ch);
		for (const width of narrow) assertFits(panel.render(width), width);
	});
});
