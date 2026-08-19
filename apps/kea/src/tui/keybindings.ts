export interface KeyBinding {
	name: string;
	key: string;
	description: string;
}

// Static keybinding table for the help panel only: the real key handling lives hardcoded in
// controllers/editor-keyboard.ts and does not read this table — an override here would be a silent no-op.
export const KEY_BINDINGS: KeyBinding[] = [
	{ name: "app.interrupt", key: "Esc", description: "interrupt streaming (open dialogs receive Esc first)" },
	{ name: "app.exit", key: "Ctrl+C/D ×2", description: "exit (press twice when idle)" },
	{
		name: "app.clear-or-exit",
		key: "Ctrl+C/D",
		description: "streaming=clear draft or abort; idle=clear input + arm exit, again=exit",
	},
	{ name: "mode.plan", key: "Shift+Tab", description: "toggle plan mode" },
	{ name: "input.submit", key: "Enter", description: "submit" },
	{ name: "input.newline", key: "Ctrl+J", description: "newline" },
	{ name: "input.steer", key: "Ctrl+S", description: "steer mid-stream (does not interrupt the turn)" },
	{ name: "autocomplete.apply", key: "Tab", description: "apply completion" },
	{ name: "transcript.expand", key: "Ctrl+O", description: "expand/collapse tool output" },
	{ name: "todo.expand", key: "Ctrl+T", description: "expand/collapse the todo panel (when it overflows)" },
];
