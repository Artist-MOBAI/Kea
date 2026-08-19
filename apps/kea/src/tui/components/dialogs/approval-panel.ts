import { type Component, type Focusable, Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { RUNNING_MARK, SELECT_POINTER } from "../../constants/symbols.ts";
import type { ApprovalDecision } from "../../state.ts";
import type { ThemeStyles } from "../../theme.ts";
import { printableKey } from "../../utils/printable-key.ts";

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME)\b/, reason: "Recursive delete of root/home" },
	{ pattern: /\bsudo\b/, reason: "Privilege escalation" },
	{ pattern: /\bgit\s+push\s+.*(-f\b|--force\b)/, reason: "Force push" },
	{ pattern: /\b(dd|mkfs)\b/, reason: "Disk-level write" },
	{ pattern: /\bchmod\s+(-R\s+)?777\b/, reason: "Wide-open permissions" },
	{ pattern: /(curl|wget)[^|]*\|\s*(bash|sh)\b/, reason: "Download-and-execute" },
];

export function detectDanger(command?: string): string | undefined {
	if (!command) return undefined;
	for (const { pattern, reason } of DANGEROUS_PATTERNS) {
		if (pattern.test(command)) return reason;
	}
	return undefined;
}

export interface ApprovalPanelProps {
	toolName: string;
	command?: string;
	path?: string;
	danger?: string;
	preview?: string[];
	styles: ThemeStyles;
}

const PREVIEW_MAX_LINES = 12;

interface Choice {
	value: ApprovalDecision["kind"] | "deny-feedback";
	label: string;
	description: string;
}

const CHOICES: Choice[] = [
	{ value: "approve", label: "Allow once", description: "this time only" },
	{
		value: "approve-session",
		label: "Allow this tool for the session",
		description: "auto-approve same-named tool calls",
	},
	{ value: "deny", label: "Deny", description: "tell the agent to try another way" },
	{ value: "deny-feedback", label: "Deny with a reason", description: "the reason is shown locally" },
];

export function headerFor(props: ApprovalPanelProps): string {
	if (props.command !== undefined) return "Run this command?";
	if (props.toolName === "write") return "Write this file?";
	if (props.toolName === "edit") return "Edit this file?";
	if (props.toolName === "exit_plan_mode") return "Approve this plan?";
	return `Allow calling ${props.toolName}?`;
}

// Choice semantics align with the MCP elicitation three states: accept / accept-session / decline (+feedback).
export class ApprovalPanel implements Component, Focusable {
	onDecision?: (decision: ApprovalDecision) => void;
	onPreview?: () => void;
	private mode: "select" | "feedback" = "select";
	private selected = 0;
	private readonly feedback = new Input();

	constructor(private readonly props: ApprovalPanelProps) {
		this.feedback.onSubmit = (value) => this.onDecision?.({ kind: "deny", feedback: value.trim() || undefined });
		this.feedback.onEscape = () => {
			this.mode = "select";
		};
	}

	invalidate(): void {
		this.feedback.invalidate();
	}

	private choose(value: Choice["value"]): void {
		if (value === "deny-feedback") {
			this.mode = "feedback";
			this.feedback.focused = this._focused;
			return;
		}
		if (value === "approve") this.onDecision?.({ kind: "approve" });
		else if (value === "approve-session") this.onDecision?.({ kind: "approve-session" });
		else this.onDecision?.({ kind: "deny" });
	}

	render(width: number): string[] {
		const { styles } = this.props;
		// The panel is mounted directly in editorSlot (no WidthSafe wrap): the bar must never exceed width (narrow-terminal hard-crash regression)
		const bar = styles.warning("─".repeat(Math.max(0, width)));
		const lines: string[] = [bar];
		lines.push(truncateToWidth(styles.bold(`${styles.warning(RUNNING_MARK)} ${headerFor(this.props)}`), width, "…"));
		if (this.props.command !== undefined)
			lines.push(truncateToWidth(styles.dim(`  $ ${this.props.command}`), width, "…"));
		if (this.props.path !== undefined) lines.push(truncateToWidth(styles.dim(`  → ${this.props.path}`), width, "…"));
		if (this.props.danger !== undefined)
			lines.push(truncateToWidth(styles.error(`  Dangerous: ${this.props.danger}`), width, "…"));
		if (this.props.preview !== undefined && this.props.preview.length > 0) {
			const shown = this.props.preview.slice(0, PREVIEW_MAX_LINES);
			for (const line of shown) lines.push(truncateToWidth(`  ${line}`, width, "…"));
			if (this.props.preview.length > PREVIEW_MAX_LINES) {
				lines.push(
					truncateToWidth(
						styles.faint(`  … (${this.props.preview.length - PREVIEW_MAX_LINES} more lines)`),
						width,
						"…",
					),
				);
			}
		}
		lines.push("");

		if (this.mode === "feedback") {
			lines.push(truncateToWidth(styles.dim("Denial reason (Enter to submit, Esc to go back):"), width, "…"));
			// Feedback input width must be ≤ layout width (on narrow terminals Math.max(width-2, 8) would render wider than the panel → hard crash)
			lines.push(...this.feedback.render(Math.max(0, width - 2)));
		} else {
			CHOICES.forEach((choice, i) => {
				const pointer = i === this.selected ? styles.warning(`${SELECT_POINTER} `) : "  ";
				const label = i === this.selected ? styles.bold(choice.label) : choice.label;
				lines.push(truncateToWidth(`${pointer}${i + 1}. ${label}  ${styles.dim(choice.description)}`, width, "…"));
			});
			lines.push("");
			const previewHint = this.props.preview !== undefined && this.props.preview.length > 0 ? " · Ctrl+E preview" : "";
			lines.push(
				truncateToWidth(
					styles.faint(`↑↓/1-4 choose · Enter confirm · Esc deny${previewHint} · Ctrl+O expand output`),
					width,
					"…",
				),
			);
		}
		lines.push(bar);
		return lines;
	}

	handleInput(data: string): void {
		if (this.mode === "feedback") {
			this.feedback.handleInput(data);
			return;
		}
		// Ctrl+O is not handled here: the global input listener (editor-keyboard) consumes it first
		// and toggles expansion uniformly.
		if (matchesKey(data, "ctrl+e")) {
			if (this.onPreview) this.onPreview();
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = this.selected === 0 ? CHOICES.length - 1 : this.selected - 1;
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = this.selected === CHOICES.length - 1 ? 0 : this.selected + 1;
			return;
		}
		const index = "1234".indexOf(printableKey(data));
		if (index >= 0) {
			const item = CHOICES[index];
			if (item) this.choose(item.value);
			return;
		}
		if (matchesKey(data, "enter")) {
			const item = CHOICES[this.selected];
			if (item) this.choose(item.value);
			return;
		}
		if (matchesKey(data, "escape")) this.onDecision?.({ kind: "deny" });
	}

	// Propagates focus to the embedded feedback input (IME candidate window positioning).
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.feedback.focused = value && this.mode === "feedback";
	}
}
