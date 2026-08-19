import { type Component, type Focusable, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeStyles } from "../../theme.ts";
import { printableKey } from "../../utils/printable-key.ts";

const PAGE = 10;

export class InfoPanel implements Component, Focusable {
	private _focused = false;
	private scroll = 0;

	constructor(
		private readonly styles: ThemeStyles,
		private readonly title: string,
		private readonly lines: string[],
		private readonly onClose: () => void,
		private readonly maxVisible = 20,
	) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	invalidate(): void {}

	private clamp(): void {
		const max = Math.max(0, this.lines.length - this.maxVisible);
		this.scroll = Math.max(0, Math.min(this.scroll, max));
	}

	render(width: number): string[] {
		this.clamp();
		const window = this.lines.slice(this.scroll, this.scroll + this.maxVisible);
		const out = [
			this.styles.primary("─".repeat(width)),
			`${this.styles.primary(this.styles.bold(` ${this.title} `))}${this.styles.faint("· ↑↓/PgDn to scroll · g/G top/bottom · Esc to close")}`,
			...window.map((line) => truncateToWidth(line, width, "…")),
		];
		if (this.lines.length > this.maxVisible) {
			out.push(this.styles.faint(` Showing ${this.scroll + 1}-${this.scroll + window.length} / ${this.lines.length}`));
		}
		out.push(this.styles.primary("─".repeat(width)));
		// pi-tui hard-crashes on over-width rows and dialogs mount without width protection:
		// clamp every row (body rows are already truncated separately; this is a fallback).
		return out.map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		const ch = printableKey(data);
		if (matchesKey(data, "escape") || ch.toLowerCase() === "q" || matchesKey(data, "enter")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, "up")) this.scroll -= 1;
		else if (matchesKey(data, "down")) this.scroll += 1;
		else if (matchesKey(data, "pageUp")) this.scroll -= PAGE;
		else if (matchesKey(data, "pageDown")) this.scroll += PAGE;
		else if (matchesKey(data, "home") || ch === "g") this.scroll = 0;
		else if (matchesKey(data, "end") || ch === "G") this.scroll = Number.MAX_SAFE_INTEGER;
		this.clamp();
	}
}
