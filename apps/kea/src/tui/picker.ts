import {
	type Component,
	type Focusable,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { printableKey } from "./utils/printable-key.ts";

export interface PickerCallbacks {
	onPick: (value: string) => void;
	onCancel: () => void;
}

export interface PickerItem {
	value: string;
	label: string;
	description?: string;
}

export class FilterablePicker implements Component, Focusable {
	focused = false;
	private filter = "";
	private readonly list: SelectList;

	constructor(
		items: SelectItem[],
		theme: SelectListTheme,
		private readonly callbacks: PickerCallbacks,
		private readonly header: (filter: string) => string,
		maxVisible = 12,
		/** Optional frame painter: adds a `─` line above and below */
		private readonly frame?: (s: string) => string,
		// Extra key hook (e.g. Alt+S session-level selection): called before filter append and
		// SelectList dispatch; returning true consumes the input. SelectList exposes no custom key
		// binding, so this is the minimal mechanism without patching pi-tui.
		private readonly onKey?: (data: string) => boolean,
		/** Standalone notice line below the header; already colored, width clamped by render */
		private readonly notice?: string,
	) {
		this.list = new SelectList(items, maxVisible, theme);
		this.list.onSelect = (item) => this.callbacks.onPick(item.value);
		this.list.onCancel = () => this.callbacks.onCancel();
	}

	/** Currently highlighted item (for the onKey hook to read the selected value). */
	getSelectedItem(): SelectItem | null {
		return this.list.getSelectedItem();
	}

	render(width: number): string[] {
		const lines = [truncateToWidth(this.header(this.filter), width, "…")];
		if (this.notice !== undefined) lines.push(truncateToWidth(this.notice, width, "…"));
		lines.push(...this.list.render(width).map((line) => truncateToWidth(line, width, "…")));
		if (this.frame) return [this.frame("─".repeat(width)), ...lines, this.frame("─".repeat(width))];
		return lines;
	}

	invalidate(): void {
		this.list.invalidate();
	}

	handleInput(data: string): void {
		if (this.onKey?.(data) === true) return;
		if (matchesKey(data, "backspace") || data === "\b") {
			this.filter = this.filter.slice(0, -1);
			this.list.setFilter(this.filter);
			return;
		}
		// Decode printable keys first (they arrive as CSI-u under Kitty flag 1); backspace/function keys go through matchesKey/SelectList dispatch
		const ch = printableKey(data);
		if (ch.length === 1 && ch.charCodeAt(0) >= 32) {
			this.filter += ch;
			this.list.setFilter(this.filter);
			return;
		}
		this.list.handleInput(data);
	}
}

export function pickerTheme(styles: { primary: (s: string) => string; dim: (s: string) => string }): SelectListTheme {
	return {
		selectedPrefix: styles.primary,
		selectedText: styles.primary,
		description: styles.dim,
		scrollInfo: styles.dim,
		noMatch: styles.dim,
	};
}
