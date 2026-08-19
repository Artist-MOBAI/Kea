import { type Component, type Focusable, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { SELECT_POINTER } from "../../constants/symbols.ts";
import type { ThemeStyles } from "../../theme.ts";

export type TrustChoice = "trust" | "distrust";

export interface TrustPromptOptions {
	workDir: string;
	gatedMcpServers: readonly string[];
	onSelect: (choice: TrustChoice) => void;
}

interface TrustOption {
	value: TrustChoice;
	label: string;
	description: string;
}

const OPTIONS: readonly TrustOption[] = [
	{
		value: "trust",
		label: "Trust this folder",
		description: "enables project-level MCP servers, remembers the folder",
	},
	{ value: "distrust", label: "Don't trust", description: "exit Kea, ask again on next launch" },
];

export class TrustPrompt implements Component, Focusable {
	focused = false;
	private selected = 0;

	constructor(
		private readonly opts: TrustPromptOptions,
		private readonly styles: ThemeStyles,
	) {}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.opts.onSelect("distrust");
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(OPTIONS.length - 1, this.selected + 1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "space")) {
			const option = OPTIONS[this.selected];
			if (option) this.opts.onSelect(option.value);
		}
	}

	render(width: number): string[] {
		const styles = this.styles;
		// Mounted bare by cli.ts (no WidthSafe): no row may exceed the real width (narrow-terminal
		// hard-crash regression). The wrap floor of 8 only feeds wrapping math — rows are truncated
		// back to the real width, so wrap width never leaks into output width.
		const renderWidth = Math.max(0, width);
		const wrapWidth = Math.max(8, renderWidth - 2);
		const rule = styles.primary("─".repeat(renderWidth));
		const lines: string[] = [
			rule,
			truncateToWidth(styles.primary(styles.bold(" Trust this folder?")), renderWidth),
			truncateToWidth(styles.faint(" ↑↓ to choose · Enter to confirm · Esc to exit"), renderWidth),
			"",
			...wrapTextWithAnsi(this.opts.workDir, wrapWidth).map((l) => truncateToWidth(` ${styles.bold(l)}`, renderWidth)),
			"",
		];

		const notice =
			this.opts.gatedMcpServers.length > 0
				? `Kea only loads project-level MCP servers (.kea/mcp.json) in trusted folders — they run as local processes. This folder defines: ${this.opts.gatedMcpServers.join(", ")}.`
				: "Kea only loads project-level MCP servers (.kea/mcp.json) in trusted folders — they run as local processes.";
		for (const line of wrapTextWithAnsi(notice, wrapWidth)) {
			lines.push(truncateToWidth(` ${styles.dim(line)}`, renderWidth));
		}
		lines.push("");

		OPTIONS.forEach((option, i) => {
			const pointer = i === this.selected ? styles.primary(`${SELECT_POINTER} `) : "  ";
			const label = i === this.selected ? styles.bold(option.label) : option.label;
			lines.push(truncateToWidth(`${pointer}${label}  ${styles.dim(option.description)}`, renderWidth, "…"));
		});
		lines.push(rule);
		return lines;
	}
}
