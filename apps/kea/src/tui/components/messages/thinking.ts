import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { BRANCH_BULLET, SPINNER_FRAMES } from "../../constants/symbols.ts";
import type { ThemeStyles } from "../../theme.ts";
import { MIN_WRAP_WIDTH, WidthCache } from "./render-cache.ts";
import { MESSAGE_INDENT, prefixLines } from "./text-util.ts";

const PREVIEW_LINES = 2;
const SPINNER_INTERVAL_MS = 100;

/** Live spinner frame index: dep and rendering share the same derivation, so dep advances exactly on frame switch. */
function spinnerFrame(): number {
	return Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
}

// live: dim spinner + preview of the last N lines; finalized: dim collapsed with a `─ ` branch bullet;
// expansion shares the global Ctrl+O toggle with tool output.
export class ThinkingView implements Component {
	readonly flushLeft = true;
	// Thinking branches are always dim.
	readonly junctionPaint: (s: string) => string;
	private text = "";
	private mode: "live" | "finalized" = "live";
	private readonly textComponent: Text;
	private readonly cache = new WidthCache();

	constructor(
		private readonly styles: ThemeStyles,
		private readonly isExpanded: () => boolean = () => false,
	) {
		this.junctionPaint = styles.dim;
		this.textComponent = new Text("", 0, 0);
	}

	setText(text: string): void {
		if (this.text === text) return;
		this.text = text;
		this.cache.invalidate();
		this.textComponent.setText(this.styles.dim(text));
	}

	finalize(): void {
		if (this.mode === "finalized") return;
		this.mode = "finalized";
		this.cache.invalidate();
	}

	invalidate(): void {
		this.cache.invalidate();
		this.textComponent.invalidate();
	}

	render(width: number): string[] {
		if (this.text === "") return [];
		// dep captures every state that affects rendering without invalidate: the live spinner frame
		// advances with time (finalized stays 0, so its cache isn't broken by time), and Ctrl+O toggle
		// only requests render, never invalidates.
		const frame = this.mode === "live" ? spinnerFrame() : 0;
		return this.cache.render(width, [this.mode, this.isExpanded(), frame], (w) => {
			const contentWidth = Math.max(1, w - MESSAGE_INDENT.length);
			const contentLines = this.textComponent.render(contentWidth);

			if (this.mode === "live") {
				const glyph = SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0];
				const visible = contentLines.length > PREVIEW_LINES ? contentLines.slice(-PREVIEW_LINES) : contentLines;
				return [`${this.styles.dim(glyph)} ${this.styles.dim("thinking…")}`, ...visible.map((l) => MESSAGE_INDENT + l)];
			}

			const lines = prefixLines(contentLines, this.styles.dim(BRANCH_BULLET), MESSAGE_INDENT);
			if (!this.isExpanded() && contentLines.length > 1 + PREVIEW_LINES) {
				const remaining = contentLines.length - (1 + PREVIEW_LINES);
				const hint = this.styles.faint(`…(${remaining} lines · Ctrl+O expands)`);
				return [
					...lines.slice(0, 1 + PREVIEW_LINES),
					MESSAGE_INDENT + truncateToWidth(hint, Math.max(w - 2, MIN_WRAP_WIDTH)),
				];
			}
			return lines;
		});
	}
}
