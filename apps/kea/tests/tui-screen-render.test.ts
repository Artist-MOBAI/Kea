import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type KernelEvent, KernelEventBus } from "@kea/core";
import { describe, expect, test } from "vitest";
import { RoundSection } from "../src/tui/components/messages/round-section.ts";
import { SectionCard } from "../src/tui/components/messages/section-card.ts";
import { ToolCallView } from "../src/tui/components/messages/tool-call.ts";
import { UserMessageView } from "../src/tui/components/messages/user-message.ts";
import { WidthSafe } from "../src/tui/components/width-safe.ts";
import { subscribeKernelEvents } from "../src/tui/controllers/kernel-event-handler.ts";
import type { TUICtx } from "../src/tui/ctx.ts";
import { createTUIState, type TUIState } from "../src/tui/state.ts";
import { ansiStyles, identityMarkdownTheme } from "./helpers/styles.ts";

/**
 * Composed-pipeline width-safety test (does not import app.ts):
 * real subscribeKernelEvents + a fake TUICtx + KernelEventBus replay realistic event streams,
 * trackComponent wraps WidthSafe with the same wiring as app.ts; for each component, across the full width range from very narrow to wide,
 * assert: render/finalize don't throw, and every line's visibleWidth ≤ width.
 */

const styles = ansiStyles();

const markdownTheme = identityMarkdownTheme();

const msg = (m: unknown): AgentMessage => m as never as AgentMessage;

const WIDTHS = [5, 20, 40, 80, 120];

interface Harness {
	bus: KernelEventBus;
	state: TUIState;
	tracked: WidthSafe[];
	statuses: string[];
	errors: string[];
	unsubscribe: () => void;
}

function makeHarness(): Harness {
	const bus = new KernelEventBus();
	const state = createTUIState();
	const tracked: WidthSafe[] = [];
	const statuses: string[] = [];
	const errors: string[] = [];
	const ctx = {
		tui: { requestRender: () => {} },
		state,
		kernel: { events: bus, todos: [] },
		styles: () => styles,
		markdownTheme: () => markdownTheme,
		// Same wiring as app.ts: trackComponent wraps the global WidthSafe guard
		trackComponent: (component: unknown) => tracked.push(new WidthSafe(component as never)),
		refreshFooter: () => {},
		todoPanel: { setTodos: () => {}, clear: () => {} },
		summarizeTurn: async () => undefined,
		trimTranscriptWindow: () => {},
		showStatus: (text: string) => statuses.push(text),
		showError: (text: string) => errors.push(text),
		notifier: { notify: () => {} },
	};
	const unsubscribe = subscribeKernelEvents(ctx as never as TUICtx);
	return { bus, state, tracked, statuses, errors, unsubscribe };
}

function assertWidthSafe(tracked: WidthSafe[], checkpoint: string): void {
	for (const [index, component] of tracked.entries()) {
		for (const width of WIDTHS) {
			let lines: string[];
			try {
				lines = component.render(width);
			} catch (err) {
				throw new Error(`render threw (component #${index}, width=${width}, at ${checkpoint}): ${err}`);
			}
			for (const line of lines) {
				expect(
					visibleWidth(line),
					`over-wide line (component #${index}, width=${width}, at ${checkpoint}): ${JSON.stringify(
						line.slice(0, 80),
					)}`,
				).toBeLessThanOrEqual(width);
			}
		}
	}
}

const unbreakableUrl = `https://example.org/${"a".repeat(280)}`;
const unbreakableToken = `L${"o".repeat(500)}ng`;
// cjk-fixture: CJK/fullwidth fixtures drive width-safe wrapping of non-ASCII text
const cjkSentence = "我们正在对实验结果进行复核，所有指标都需要重新计算以确认显著性，请注意保留原始随机种子。";
const cjkUnbreakable = "数".repeat(300);
const fullWidthBlocks = "█▓▒░◆◇○●□■△▲※→←↑↓";
const ansiInContent = "\x1b[1m\x1b[31mCRITICAL\x1b[0m failure at \x1b[33mstage-2\x1b[0m";
const toolPreview = [
	"METRIC score=1022.5",
	`unbroken ${"Z".repeat(400)} tail`,
	cjkSentence,
	`\x1b[32mgreen\x1b[0m ${fullWidthBlocks}`,
].join("\n");

describe("TUI composed-pipeline width safety (transcript/section-card/caption × KernelEvent stream)", () => {
	test("full two-round event stream (streaming body/tool cards/compaction/failed outcome): no throw, width-safe", () => {
		const h = makeHarness();
		const emit = (e: KernelEvent) => h.bus.emit(e);
		const assistantMsg = msg({ role: "assistant", content: [{ type: "text", text: "" }], timestamp: 1 });

		emit({ type: "run_start", runId: "run-a" });
		emit({ type: "message_start", message: assistantMsg });
		// cjk-fixture: inline CJK around the unbreakable URL (width exercise)
		emit({ type: "message_delta", message: assistantMsg, text: `开始复核。参考 ${unbreakableUrl} 的数据。` });
		assertWidthSafe(h.tracked, "round A mid-stream (CJK + long token)");
		h.state.currentSection?.tick();
		h.state.currentSection?.tick();
		emit({
			type: "message_delta",
			message: assistantMsg,
			text: `开始复核。参考 ${unbreakableUrl} 的数据。${ansiInContent} ${unbreakableToken}`,
			thinking: `${cjkUnbreakable}${fullWidthBlocks}`,
		});
		assertWidthSafe(h.tracked, "round A mid-stream (ANSI + thinking)");

		emit({
			type: "tool_start",
			toolCallId: "t1",
			name: "bash",
			args: { command: `analyze_${"x".repeat(300)} --strict` },
		});
		assertWidthSafe(h.tracked, "round A tool running");
		emit({ type: "tool_update", toolCallId: "t1", name: "bash", partial: `partial ${"p".repeat(200)}` });
		emit({
			type: "tool_end",
			toolCallId: "t1",
			name: "bash",
			isError: false,
			durationMs: 1200,
			resultPreview: toolPreview,
		});
		assertWidthSafe(h.tracked, "round A tool finished (overlong preview)");

		emit({ type: "tool_start", toolCallId: "t2", name: "read", args: { path: `/proj/${"deep/".repeat(40)}leaf.ts` } });
		emit({
			type: "tool_end",
			toolCallId: "t2",
			name: "read",
			isError: false,
			durationMs: 15,
			resultPreview: `${cjkSentence}\n${"M".repeat(350)}`,
		});
		emit({ type: "tool_start", toolCallId: "t3", name: "grep", args: { pattern: unbreakableToken } });
		emit({
			type: "tool_end",
			toolCallId: "t3",
			name: "grep",
			isError: true,
			durationMs: 40,
			resultPreview: `error: ${ansiInContent} ${"E".repeat(260)}`,
		});
		assertWidthSafe(h.tracked, "round A after multiple tools");

		emit({ type: "message_delta", message: assistantMsg, text: `${cjkSentence}${fullWidthBlocks} done.` });
		emit({ type: "message_end", message: assistantMsg, text: `${cjkSentence}${fullWidthBlocks} done.` });
		emit({ type: "compaction_started" });
		assertWidthSafe(h.tracked, "round A mid-compaction");
		emit({ type: "compaction_applied", tokensBefore: 12000, tokensAfter: 3200 });
		emit({ type: "run_end", runId: "run-a", outcome: "completed" });
		assertWidthSafe(h.tracked, "round A after finalize");
		expect(h.state.currentSection).toBeUndefined();

		const assistantMsg2 = msg({ role: "assistant", content: [{ type: "text", text: "" }], timestamp: 2 });
		emit({ type: "run_start", runId: "run-b" });
		emit({ type: "message_start", message: assistantMsg2 });
		emit({ type: "message_delta", message: assistantMsg2, text: cjkUnbreakable });
		assertWidthSafe(h.tracked, "round B mid-stream (fullwidth, no spaces)");
		// cjk-fixture: CJK command argument (width exercise)
		emit({ type: "tool_start", toolCallId: "t4", name: "run_experiment", args: { command: `${"实验".repeat(150)}` } });
		emit({
			type: "tool_end",
			toolCallId: "t4",
			name: "run_experiment",
			isError: false,
			durationMs: 900,
			resultPreview: `${fullWidthBlocks}\nMETRIC score=0.1`,
			details: { jobId: "019fe9ffaaaa", backend: "local" },
		});
		emit({ type: "compaction_started" });
		emit({ type: "compaction_failed", reason: `summary provider exploded ${"e".repeat(200)}` });
		assertWidthSafe(h.tracked, "round B after compaction failure");
		emit({ type: "model_retry", attempt: 1, maxAttempts: 3, delayMs: 800, errorMessage: "ECONNRESET" });
		emit({ type: "run_end", runId: "run-b", outcome: "failed", error: `ECONNREFUSED ${"q".repeat(300)}` });
		assertWidthSafe(h.tracked, "round B after finalize (failed outcome)");

		expect(h.tracked.length).toBeGreaterThanOrEqual(6);
		expect(h.errors.some((e) => e.includes("ECONNREFUSED"))).toBe(true);
		h.unsubscribe();
	});

	test("mid-stream checkpoints + empty-delta noise: lazy mounting creates no empty rounds, width-safe", () => {
		const h = makeHarness();
		const emit = (e: KernelEvent) => h.bus.emit(e);
		const assistantMsg = msg({ role: "assistant", content: [{ type: "text", text: "" }], timestamp: 1 });

		emit({ type: "run_start", runId: "run-c" });
		emit({ type: "message_start", message: assistantMsg });
		emit({ type: "message_delta", message: assistantMsg, text: "" });
		emit({ type: "message_delta", message: assistantMsg, text: "   " });
		expect(h.tracked).toHaveLength(0);
		expect(h.state.currentSection).toBeUndefined();

		emit({ type: "message_delta", message: assistantMsg, text: `${unbreakableToken} ${cjkSentence}` });
		expect(h.tracked.length).toBeGreaterThan(0);
		assertWidthSafe(h.tracked, "after first non-empty delta");
		h.state.currentSection?.tick();
		assertWidthSafe(h.tracked, "after tick");

		emit({ type: "message_end", message: assistantMsg, text: `${unbreakableToken} ${cjkSentence}` });
		emit({ type: "run_end", runId: "run-c", outcome: "aborted" });
		assertWidthSafe(h.tracked, "after aborted finalize");
		expect(h.state.currentSection).toBeUndefined();
		h.unsubscribe();
	});
});

describe("round-end frame color (completed → back to default border, failed → error)", () => {
	const paintedPrefix = (paint: (s: string) => string, glyph: string): string => paint(glyph).slice(0, -4);

	test("completed card frame returns to the default border, no longer primary blue", () => {
		const section = new RoundSection(styles);
		section.appendUser(msg({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }));
		section.finish([], 100, false);
		const lines = section.render(60);
		expect(lines[0] ?? "").toContain(paintedPrefix(styles.border, "╭"));
		expect(lines.join("\n")).not.toContain(paintedPrefix(styles.primary, "╭"));
	});

	test("failed frame keeps error red", () => {
		const section = new RoundSection(styles);
		section.appendUser(msg({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }));
		section.finish([], 100, true);
		const lines = section.render(60);
		expect(lines[0] ?? "").toContain(paintedPrefix(styles.error, "╭"));
	});
});

describe("SectionCard branch-node color (├ shares the branch glyph color, not rewritten by the frozen frame)", () => {
	test("user branch: after the round-end frame freezes to primary, ├ still matches > as userMark", () => {
		const card = new SectionCard(styles, "agent", styles.userMark);
		card.addChild(
			new UserMessageView(msg({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }), styles),
		);
		card.setFrame(styles.primary);
		const userLine = card.render(60).find((l) => l.includes("hello")) ?? "";
		expect(userLine.startsWith(styles.userMark("├"))).toBe(true);
	});

	test("tool branch: ├ follows the status color (done=success)", () => {
		const card = new SectionCard(styles, "agent", styles.primary);
		const view = new ToolCallView({
			name: "read",
			args: { path: "a.ts" },
			cwd: "/p",
			styles,
			isExpanded: () => false,
			requestRender: () => {},
		});
		view.finish({ durationMs: 5, preview: "ok", isError: false });
		card.addChild(view);
		const toolLine = card.render(60).find((l) => l.includes("Used read")) ?? "";
		expect(toolLine.startsWith(styles.success("├"))).toBe(true);
	});

	test("tool branch: ├ is error-colored in the error state", () => {
		const card = new SectionCard(styles, "agent", styles.primary);
		const view = new ToolCallView({
			name: "bash",
			args: { command: "false" },
			cwd: "/p",
			styles,
			isExpanded: () => false,
			requestRender: () => {},
		});
		view.finish({ durationMs: 5, preview: "boom", isError: true });
		card.addChild(view);
		const toolLine = card.render(60).find((l) => l.includes("Ran a command")) ?? "";
		expect(toolLine.startsWith(styles.error("├"))).toBe(true);
	});
});
