import { type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeyBinding } from "../../keybindings.ts";
import type { ThemeStyles } from "../../theme.ts";
import { printableKey } from "../../utils/printable-key.ts";

export interface HelpCommandRow {
	name: string;
	aliases?: readonly string[];
	description: string;
}

export interface HelpPanelOptions {
	onClose: () => void;
	maxVisible?: number;
}

export class HelpPanel implements Component, Focusable {
	focused = false;
	private scrollTop = 0;

	constructor(
		readonly styles: ThemeStyles,
		private readonly bindings: KeyBinding[],
		private readonly commands: HelpCommandRow[],
		private readonly opts: HelpPanelOptions,
	) {}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || printableKey(data).toLowerCase() === "q") {
			this.opts.onClose();
			return;
		}
		if (matchesKey(data, "up")) this.scrollTop -= 1;
		else if (matchesKey(data, "down")) this.scrollTop += 1;
		else if (matchesKey(data, "pageUp")) this.scrollTop -= 10;
		else if (matchesKey(data, "pageDown")) this.scrollTop += 10;
	}

	render(width: number): string[] {
		const { styles } = this;
		const keyWidth = Math.max(8, ...this.bindings.map((b) => visibleWidth(b.key))) + 2;
		const labels = this.commands.map((c) => `/${c.name}`);
		const suffixes = this.commands.map((c) =>
			c.aliases?.length ? `(${c.aliases.map((a) => `/${a}`).join(", ")})` : "",
		);
		const rowWidths = this.commands.map(
			(_, i) => visibleWidth(labels[i] ?? "") + (suffixes[i] ? visibleWidth(suffixes[i] ?? "") + 1 : 0),
		);
		const cmdWidth = Math.max(12, ...rowWidths) + 2;

		const lines: string[] = [
			styles.primary("─".repeat(width)),
			`${styles.primary(styles.bold(" help "))}${styles.faint("· Esc / Enter / q to close · ↑↓ to scroll")}`,
			"",
			`  ${styles.dim("Type a message to start, or use a command below.")}`,
			"",
			`  ${styles.bold("shortcuts")}`,
			...this.bindings.map((b) => `    ${styles.warning(b.key.padEnd(keyWidth))}${styles.dim(b.description)}`),
			"",
			`  ${styles.bold("all commands")}`,
			...this.commands.map((c, i) => {
				const label = labels[i] ?? "";
				const suffix = suffixes[i] ?? "";
				const pad = " ".repeat(Math.max(0, cmdWidth - (rowWidths[i] ?? 0)));
				const styled = suffix
					? `${styles.primary(label)} ${styles.dim(suffix)}${pad}${styles.dim(c.description)}`
					: `${styles.primary(label)}${pad}${styles.dim(c.description)}`;
				return `    ${styled}`;
			}),
			"",
			styles.primary("─".repeat(width)),
		];

		const content = lines.slice(1, lines.length - 1);
		const maxVisible = Math.max(5, this.opts.maxVisible ?? 24);
		if (content.length > maxVisible) {
			this.scrollTop = Math.max(0, Math.min(this.scrollTop, content.length - maxVisible));
			const slice = content.slice(this.scrollTop, this.scrollTop + maxVisible);
			const info = styles.faint(` Showing ${this.scrollTop + 1}-${this.scrollTop + slice.length} / ${content.length}`);
			return [lines[0] ?? "", ...slice, info, lines.at(-1) ?? ""].map((line) => truncateToWidth(line, width));
		}
		this.scrollTop = 0;
		return lines.map((line) => truncateToWidth(line, width));
	}
}
