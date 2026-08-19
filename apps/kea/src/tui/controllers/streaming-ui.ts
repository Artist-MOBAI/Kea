import type { AssistantMessageView } from "../components/messages/assistant-message.ts";
import type { ToolCallView } from "../components/messages/tool-call.ts";

export const STREAMING_FLUSH_MS = 50;

// Delta events carry the accumulated full text: coalesce for 50ms and setText once, avoiding a rebuild per token.
export class StreamingController {
	private timer?: ReturnType<typeof setTimeout>;
	private pendingText = "";
	private pendingThinking?: string;
	private lastFlushAt = 0;

	constructor(
		private readonly view: () => AssistantMessageView | undefined,
		private readonly requestRender: () => void,
	) {}

	onDelta(text: string, thinking?: string): void {
		this.pendingText = text;
		if (thinking !== undefined) this.pendingThinking = thinking;
		// First delta flushes immediately (leading edge); afterwards throttle by the window.
		const elapsed = Date.now() - this.lastFlushAt;
		if (elapsed >= STREAMING_FLUSH_MS) {
			this.flush();
			return;
		}
		this.timer ??= setTimeout(() => this.flush(), STREAMING_FLUSH_MS - elapsed);
	}

	flush(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.lastFlushAt = Date.now();
		const view = this.view();
		if (!view) return;
		view.update(this.pendingText, this.pendingThinking);
		this.requestRender();
	}

	onEnd(text: string): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const view = this.view();
		view?.finalize(text);
		// Clear pending state: the controller is reused across messages — stale thinking/text
		// would otherwise be flushed into the next message's first flush.
		this.pendingText = "";
		this.pendingThinking = undefined;
		this.lastFlushAt = 0;
		this.requestRender();
	}

	dispose(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		// An interrupted run never reaches onEnd: clear pending content here, or the previous run's
		// thinking/text leaks into the next message's first flush.
		this.pendingText = "";
		this.pendingThinking = undefined;
		this.lastFlushAt = 0;
	}
}

// tool_update coalescer: a busy tool emits dozens of partials per second and a render per partial
// saturates the frame loop — merge text per toolCallId so each window renders once (leading edge lands
// immediately; flush before tool_end/run_end closes the tail window).
export class ToolUpdateCoalescer {
	private timer?: ReturnType<typeof setTimeout>;
	private pending = new Map<string, string>();
	private lastFlushAt = 0;

	constructor(
		private readonly view: (toolCallId: string) => ToolCallView | undefined,
		private readonly requestRender: () => void,
	) {}

	onUpdate(toolCallId: string, text: string): void {
		if (text === "") return;
		this.pending.set(toolCallId, (this.pending.get(toolCallId) ?? "") + text);
		const elapsed = Date.now() - this.lastFlushAt;
		if (elapsed >= STREAMING_FLUSH_MS) {
			this.flush();
			return;
		}
		this.timer ??= setTimeout(() => this.flush(), STREAMING_FLUSH_MS - elapsed);
	}

	flush(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.pending.size === 0) return;
		this.lastFlushAt = Date.now();
		let applied = false;
		for (const [toolCallId, text] of this.pending) {
			const view = this.view(toolCallId);
			// Silently drop late partials (tool_end already removed the view).
			if (view) {
				view.appendLiveText(text);
				applied = true;
			}
		}
		this.pending.clear();
		if (applied) this.requestRender();
	}

	// Session switch: pending partials belong to the interrupted run (replay rebuilds views) — drop them.
	dispose(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.pending.clear();
		this.lastFlushAt = 0;
	}
}
