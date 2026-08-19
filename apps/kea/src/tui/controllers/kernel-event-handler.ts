import { type KernelEvent, TODO_LIST_TOOL_NAME } from "@kea/core";
import { z } from "zod";
import { AssistantMessageView } from "../components/messages/assistant-message.ts";
import { describeTool, describeToolDone, firstSentence } from "../components/messages/caption-text.ts";
import { CompactionView } from "../components/messages/compaction.ts";
import { RoundSection } from "../components/messages/round-section.ts";
import { contentTextOf, ToolCallView } from "../components/messages/tool-call.ts";
import type { TUICtx } from "../ctx.ts";
import { classifyError } from "./error-classify.ts";
import { replayTranscript } from "./session-replay.ts";
import { StreamingController, ToolUpdateCoalescer } from "./streaming-ui.ts";
import { KEEP_RECENT_STEPS } from "./transcript-window.ts";

/**
 * TodoItem runtime shape (core exports only a TS interface, not a zod schema). Tool arguments come
 * from the LLM and must be safeParse'd: dirty data skips this panel refresh, never enters the panel.
 */
const todoItemsSchema = z.array(
	z.object({
		title: z.string(),
		status: z.enum(["pending", "in_progress", "done"]),
	}),
);

const captionTimers = new WeakMap<TUICtx, ReturnType<typeof setInterval>>();
function stopCaptionTick(ctx: TUICtx): void {
	const timer = captionTimers.get(ctx);
	if (timer !== undefined) {
		clearInterval(timer);
		captionTimers.delete(ctx);
	}
}

function startCaptionTick(ctx: TUICtx): void {
	// Per-instance (WeakMap): a module singleton would drive a stale instance's render loop
	// when a second KeaTUI exists in-process (tests/embedding).
	if (captionTimers.has(ctx)) return;
	const timer = setInterval(() => ctx.state.currentSection?.tick(), 160);
	timer.unref?.();
	captionTimers.set(ctx, timer);
}

function ensureAgentSection(ctx: TUICtx): void {
	if (!ctx.state.currentSection) {
		const section = new RoundSection(ctx.styles(), () => ctx.tui.requestRender());
		ctx.state.currentSection = section;
		ctx.state.sectionParts = [];
		ctx.state.sectionStartedAt = Date.now();
		// Mount the card and caption independently: live caption updates do not disturb the context card.
		ctx.trackComponent(section);
		ctx.trackComponent(section.caption);
	}
	ctx.state.currentSection.activateAgent();
	startCaptionTick(ctx);
}

export function subscribeKernelEvents(ctx: TUICtx): () => void {
	const streaming = new StreamingController(
		() => ctx.state.streaming,
		() => ctx.tui.requestRender(),
	);
	// High-frequency tool_update partials go through 50ms coalescing (first one lands immediately via the leading edge); flush before finish.
	const toolUpdates = new ToolUpdateCoalescer(
		(toolCallId) => ctx.state.toolViews.get(toolCallId),
		() => ctx.tui.requestRender(),
	);
	let compactionView: CompactionView | undefined;
	let compactionTimer: ReturnType<typeof setInterval> | undefined;
	const toolMeta = new Map<string, { name: string; args: unknown }>();
	const stopCompactionTick = () => {
		if (compactionTimer !== undefined) {
			clearInterval(compactionTimer);
			compactionTimer = undefined;
		}
	};

	const unsubscribe = ctx.kernel.events.subscribe((event: KernelEvent) => {
		const styles = ctx.styles();
		switch (event.type) {
			case "message_start": {
				if ("role" in event.message && event.message.role === "assistant") {
					// Lazy mount: create the view only on the first non-empty delta — pi emits an empty
					// assistant message_start at turn start/resend, so creating the view here would
					// render duplicate thinking blocks on repeated starts.
					if (!ctx.state.streaming) ctx.state.streamingMessage = event.message;
				}
				break;
			}
			case "message_delta": {
				// pi copies the partial message with {...spread} on every event, so reference comparison
				// is always false — apply to the current streaming view directly.
				if (!ctx.state.streaming) {
					const hasText = event.text !== undefined && event.text.trim() !== "";
					const hasThinking = event.thinking !== undefined && event.thinking.trim() !== "";
					if (!hasText && !hasThinking) break;
					const view = new AssistantMessageView(
						ctx.state.streamingMessage ?? event.message,
						ctx.markdownTheme(),
						styles,
						() => ctx.state.expanded,
					);
					ctx.state.streaming = view;
					ensureAgentSection(ctx);
					ctx.state.currentSection?.addAgentChild(view.thinking);
					ctx.state.currentSection?.addAgentChild(view);
					ctx.tui.requestRender();
				}
				// Live caption updates continuously with the streaming body: models usually state intent first — take the first sentence.
				if (event.text !== undefined && event.text.trim() !== "") {
					ctx.state.currentSection?.setLive(firstSentence(event.text, 120));
				}
				streaming.onDelta(event.text, event.thinking);
				break;
			}
			case "message_end": {
				if ("role" in event.message && event.message.role === "assistant") {
					ctx.state.lastAssistant = event.text;
				}
				if (ctx.state.streaming) {
					streaming.onEnd(event.text);
					ctx.state.streaming = undefined;
					ctx.refreshFooter();
				}
				break;
			}
			case "tool_start": {
				// Flush pending deltas so the tool card follows the body.
				streaming.flush();
				const view = new ToolCallView({
					name: event.name,
					args: event.args,
					cwd: process.cwd(),
					styles,
					isExpanded: () => ctx.state.expanded,
					requestRender: () => ctx.tui.requestRender(),
				});
				ensureAgentSection(ctx);
				ctx.state.toolViews.set(event.toolCallId, view);
				toolMeta.set(event.toolCallId, { name: event.name, args: event.args });
				ctx.state.currentSection?.addAgentChild(view);
				ctx.state.currentSection?.setLive(describeTool(event.name, event.args, process.cwd()));
				ctx.tui.requestRender();
				break;
			}
			case "tool_update": {
				toolUpdates.onUpdate(event.toolCallId, contentTextOf(event.partial));
				break;
			}
			case "tool_end": {
				streaming.flush();
				toolUpdates.flush();
				ctx.state.toolViews.get(event.toolCallId)?.finish({
					durationMs: event.durationMs,
					preview: event.resultPreview,
					isError: event.isError,
					details: event.details,
				});
				const meta = toolMeta.get(event.toolCallId);
				// session_switched clears toolMeta: a late tool_end has no metadata,
				// so it must not enter turn stats / the action log under an anonymous empty name.
				if (meta) {
					ctx.state.sectionParts.push({
						toolName: meta.name,
						durationMs: event.durationMs,
						isError: event.isError,
						preview: event.resultPreview,
					});
					ctx.state.currentSection?.pushDone(
						describeToolDone(meta.name, meta.args, event.durationMs, event.resultPreview, event.isError, process.cwd()),
					);
				}
				// Todo panel refresh: the call arguments are the panel's authoritative source (a failed call does not change state, so skip it).
				if (!event.isError && meta?.name === TODO_LIST_TOOL_NAME) {
					const todosArg = (meta.args as { todos?: unknown } | undefined)?.todos;
					const parsed = todoItemsSchema.safeParse(todosArg);
					if (parsed.success) ctx.todoPanel.setTodos(parsed.data);
				}
				ctx.state.currentSection?.foldOldSteps(KEEP_RECENT_STEPS);
				// The view is already mounted in the transcript card: drop the index entry to avoid unbounded growth over long sessions.
				ctx.state.toolViews.delete(event.toolCallId);
				toolMeta.delete(event.toolCallId);
				ctx.state.currentSection?.setLive("");
				ctx.tui.requestRender();
				break;
			}
			case "run_end": {
				streaming.flush();
				toolUpdates.flush();
				streaming.dispose();
				// Defensive parity with message_end/session_switched: a mid-stream abort can skip
				// message_end — leftover streaming state would let a later delta write into the finished view.
				ctx.state.streaming = undefined;
				ctx.state.streamingMessage = undefined;
				const todosNow = ctx.kernel.todos;
				if (todosNow.length > 0 && todosNow.every((t) => t.status === "done")) ctx.todoPanel.clear();
				const section = ctx.state.currentSection;
				const parts = ctx.state.sectionParts;
				if (section?.hasContent) {
					const failed = Boolean(event.error) || event.outcome === "aborted";
					section.finish(parts, Date.now() - ctx.state.sectionStartedAt, failed);
					const digest = [
						`Tool sequence: ${parts.map((p) => p.toolName).join(" → ") || "(no tools used)"}`,
						ctx.state.lastAssistant !== "" ? `Reply excerpt: ${ctx.state.lastAssistant.slice(0, 300)}` : "",
					]
						.filter(Boolean)
						.join("\n");
					void ctx
						.summarizeTurn(digest)
						.then((summary) => {
							// A session switch or dispose during the async summary unmounts this section —
							// writing into a detached component triggers a stray render.
							if (!summary || ctx.state.currentSection === undefined) return;
							section.setSummary(summary);
							ctx.tui.requestRender();
						})
						.catch(() => {});
				}
				ctx.state.currentSection = undefined;
				ctx.state.sectionParts = [];
				stopCaptionTick(ctx);
				ctx.trimTranscriptWindow();
				if (event.outcome === "aborted") ctx.showStatus("(interrupted by user)", "warning");
				if (event.error) ctx.showError(classifyError(event.error));
				ctx.notifier.notify("run-complete", event.outcome);
				ctx.refreshFooter();
				ctx.tui.requestRender();
				break;
			}
			case "model_retry": {
				// Retries stay visible to the user, never silently stuck.
				ctx.showStatus(
					`Connection error; auto-retrying ${event.attempt}/${event.maxAttempts} (waiting ${Math.round(event.delayMs / 100) / 10}s)…`,
					"warning",
				);
				break;
			}
			case "compaction_started": {
				streaming.flush();
				compactionView = new CompactionView(styles);
				ctx.trackComponent(compactionView);
				stopCompactionTick();
				compactionTimer = setInterval(() => ctx.tui.requestRender(), 100);
				ctx.tui.requestRender();
				break;
			}
			case "compaction_applied": {
				stopCompactionTick();
				if (compactionView) {
					compactionView.finish(event.tokensBefore, event.tokensAfter);
					compactionView = undefined;
				} else {
					ctx.showStatus("Context compacted (research ledger unaffected)");
				}
				ctx.refreshFooter();
				break;
			}
			case "compaction_failed": {
				stopCompactionTick();
				if (compactionView) {
					compactionView.fail(event.reason);
					compactionView = undefined;
				} else {
					ctx.showStatus(`Compaction failed${event.reason ? `: ${event.reason}` : ""}`, "error");
				}
				ctx.tui.requestRender();
				break;
			}
			case "session_switched": {
				// Session-level state must not leak across sessions: steer queue, last reply (kernel clears approval authorization on switch).
				ctx.state.steerQueue.length = 0;
				ctx.state.lastAssistant = "";
				// Clear the interrupted run's leftovers: an uncleared toolMeta lets a late tool_end
				// build a caption from stale args.
				toolMeta.clear();
				streaming.dispose();
				toolUpdates.dispose();
				ctx.state.streaming = undefined;
				ctx.state.streamingMessage = undefined;
				stopCompactionTick();
				if (compactionView) {
					compactionView.fail("interrupted by session switch");
					compactionView = undefined;
				}
				stopCaptionTick(ctx);
				ctx.state.currentSection = undefined;
				ctx.state.sectionParts = [];
				// Hydrate the Todo panel with the session (kernel already restored it from the target session transcript).
				ctx.todoPanel.setTodos(ctx.kernel.todos);
				replayTranscript(ctx);
				ctx.refreshFooter();
				break;
			}
			case "permission_mode_changed":
			case "plan_mode_changed": {
				ctx.refreshFooter();
				break;
			}
			default:
				break;
		}
	});

	return () => {
		unsubscribe();
		streaming.dispose();
		toolUpdates.dispose();
		stopCompactionTick();
		stopCaptionTick(ctx);
	};
}
