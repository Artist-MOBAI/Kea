import { join } from "node:path";
import { matchesKey } from "@earendil-works/pi-tui";
import { userConfigDir } from "../../config.ts";
import type { TUICtx } from "../ctx.ts";

const EXIT_CONFIRM_WINDOW_MS = 2000;
const HISTORY_LIMIT = 200;

export type InputListenerResult = { consume: boolean } | undefined;

// Global keyboard ladder: Ctrl+C/D cascade (deny approval → clear draft / interrupt while streaming →
// arm double-press exit when idle); Esc interrupts streaming but is delegated to the focused component
// while an approval/dialog is open; all other keys pass through to the focused component.
export function createKeyboardListener(ctx: TUICtx): (data: string) => InputListenerResult {
	const exitLadder = (kind: "ctrl-c" | "ctrl-d") => {
		const { state, kernel } = ctx;
		if (state.approval) {
			ctx.resolveApproval("deny");
			ctx.showStatus("Denied");
			return;
		}
		const hasDraft = ctx.editor.getText().trim() !== "";
		// Draft takes priority while streaming: clear it without interrupting the running turn.
		if (kernel.agent.state.isStreaming) {
			if (hasDraft) ctx.editor.setText("");
			else kernel.abort();
			return;
		}
		// Compaction tail: the agent is idle but a summary LLM call is in flight — without this
		// branch the compaction-abort path is unreachable from the TUI.
		if (kernel.isCompacting()) {
			kernel.abort();
			ctx.showStatus("Compaction interrupted");
			return;
		}
		const now = Date.now();
		if (now - state.exitArmedAt < EXIT_CONFIRM_WINDOW_MS && state.exitArmedKey === kind) {
			ctx.exit();
			return;
		}
		if (hasDraft) ctx.editor.setText("");
		state.exitArmedAt = now;
		state.exitArmedKey = kind;
		ctx.armExitHint(kind);
	};

	return (data) => {
		const { state, kernel } = ctx;

		if (matchesKey(data, "ctrl+c")) {
			exitLadder("ctrl-c");
			return { consume: true };
		}

		if (matchesKey(data, "ctrl+d")) {
			exitLadder("ctrl-d");
			return { consume: true };
		}

		if (matchesKey(data, "shift+tab")) {
			// Shift+Tab toggles plan mode, not permission.
			const next = !kernel.planMode;
			kernel.setPlanMode(next);
			ctx.showStatus(`Plan mode → ${next ? "on" : "off"}`);
			return { consume: true };
		}

		if (matchesKey(data, "ctrl+o")) {
			state.expanded = !state.expanded;
			ctx.showStatus(state.expanded ? "Tool output: expanded globally (Ctrl+O to collapse)" : "Tool output: collapsed");
			ctx.tui.requestRender();
			return { consume: true };
		}

		// Ctrl+T: expand/collapse the Todo panel; consume the key even when inactive to prevent accidental triggers.
		if (matchesKey(data, "ctrl+t")) {
			if (ctx.todoPanel.hasOverflow()) {
				ctx.todoPanel.toggleExpanded();
				ctx.tui.requestRender();
			}
			return { consume: true };
		}

		// Ctrl+S: inject steering guidance without interrupting the current turn.
		if (matchesKey(data, "ctrl+s")) {
			const text = ctx.editor.getText().trim();
			if (kernel.agent.state.isStreaming && text !== "") {
				kernel.steer(text);
				ctx.editor.setText("");
				ctx.showStatus("Steer injected; the agent will see it after this round");
			} else if (!kernel.agent.state.isStreaming) {
				ctx.showStatus("Steering needs an active run");
			}
			return { consume: true };
		}

		// When the approval overlay/dialog is open, Esc goes to the focused component, not the whole run.
		// Esc during the compaction tail aborts the summary call; during an escalation window it aborts
		// the workers and pauses the mobai (escalation awaits are otherwise unreachable by Esc).
		if (matchesKey(data, "escape") && !state.approval && !state.activeDialog) {
			if (kernel.agent.state.isStreaming || kernel.isCompacting()) {
				kernel.abort();
				ctx.showStatus("(aborted)", "warning");
				return { consume: true };
			}
			if (ctx.interruptEscalation()) return { consume: true };
		}

		// ctrl+c / ctrl+d branches already consumed and returned above; any other key reaching here disarms exit.
		if (state.exitArmedAt !== 0) state.exitArmedAt = 0;
		return undefined;
	};
}

export function historyPath(): string {
	return join(userConfigDir(), "input-history.json");
}

export async function loadInputHistory(cwd: string): Promise<string[]> {
	try {
		const file = Bun.file(historyPath());
		if (!(await file.exists())) return [];
		const all = (await file.json()) as Record<string, string[]>;
		const entries = all[cwd];
		return Array.isArray(entries) ? entries.filter((e) => typeof e === "string").slice(-HISTORY_LIMIT) : [];
	} catch {
		return [];
	}
}

export async function saveInputHistory(cwd: string, entries: string[]): Promise<void> {
	const trimmed = entries.filter((e) => e.trim() !== "").slice(-HISTORY_LIMIT);
	if (trimmed.length === 0) return;
	try {
		const file = Bun.file(historyPath());
		const all: Record<string, string[]> = (await file.exists())
			? ((await file.json()) as Record<string, string[]>)
			: {};
		all[cwd] = trimmed;
		await Bun.write(historyPath(), JSON.stringify(all, null, 2));
	} catch {
		// History persistence failure must not affect interaction.
	}
}

/** In-session history cache: the editor has built-in ↑↓ navigation; this handles persistence and seeding on startup. */
export class InputHistory {
	private entries: string[] = [];

	constructor(private readonly cwd: string) {}

	async load(): Promise<string[]> {
		this.entries = await loadInputHistory(this.cwd);
		return [...this.entries];
	}

	record(text: string): void {
		const trimmed = text.trim();
		if (trimmed === "" || this.entries[this.entries.length - 1] === trimmed) return;
		this.entries.push(trimmed);
		if (this.entries.length > HISTORY_LIMIT) this.entries = this.entries.slice(-HISTORY_LIMIT);
		void saveInputHistory(this.cwd, this.entries);
	}
}
