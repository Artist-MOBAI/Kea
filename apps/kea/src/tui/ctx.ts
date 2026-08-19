import type { Component, Editor, MarkdownTheme, TuiMainScreen } from "@earendil-works/pi-tui";
import type { Kernel, ApprovalDecision as KernelApprovalDecision } from "@kea/core";
import type { FooterView } from "./components/chrome/footer.ts";
import type { TodoPanel } from "./components/chrome/todo-panel.ts";
import type { Notifier } from "./notify.ts";
import type { TUIState } from "./state.ts";
import type { ThemeStyles } from "./theme.ts";

// Controller context: injected into each controller after the coordinator assembles it.
// Components never touch this interface — they are pure display; controllers read/write UI and kernel through it.
export interface TUICtx {
	readonly tui: TuiMainScreen;
	readonly editor: Editor;
	readonly state: TUIState;
	readonly kernel: Kernel;
	readonly footer: FooterView;
	readonly todoPanel: TodoPanel;
	readonly notifier: Notifier;
	styles(): ThemeStyles;
	markdownTheme(): MarkdownTheme;
	addText(text: string): void;
	showStatus(text: string, tone?: "dim" | "warning" | "error" | "success"): void;
	showError(text: string): void;
	/** Esc during an escalation window (agent idle): abort workers + pause mobai; true when one was in flight */
	interruptEscalation(): boolean;
	/** Append a component to the message area and register it (cleared on transcript redraw) */
	trackComponent(component: Component): void;
	clearTranscript(): void;
	/** Trim the oldest round when rounds exceed the window; full data lives in the ledger */
	trimTranscriptWindow(): void;
	refreshFooter(): void;
	/** Transient hint (exit confirmation etc.): shown in the footer, auto-expires, never enters the transcript */
	armExitHint(kind: "ctrl-c" | "ctrl-d"): void;
	/** Mount a dialog by replacing the editor, giving focus to the panel */
	mountDialog(component: Component): void;
	restoreEditor(): void;
	resolveApproval(answer: KernelApprovalDecision): void;
	/** End-of-round AI summary (async, falls back to undefined on failure, never throws) */
	summarizeTurn(digest: string): Promise<string | undefined>;
	exit(): void;
}
