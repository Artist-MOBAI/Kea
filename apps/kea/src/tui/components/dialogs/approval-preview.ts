import { type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeStyles } from "../../theme.ts";
import { printableKey } from "../../utils/printable-key.ts";

export interface ApprovalPreviewProps {
	title: string;
	/** Pre-colored rows snapshotted at construction; scrolling only slices. */
	lines: string[];
	rows: number;
	styles: ThemeStyles;
	onClose: () => void;
}

function fitExactly(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w > width) return truncateToWidth(line, width, "…");
	if (w === width) return line;
	return `${line}${" ".repeat(width - w)}`;
}

export class ApprovalPreviewViewer implements Component, Focusable {
	private scrollTop = 0;
	private _focused = false;

	constructor(private readonly props: ApprovalPreviewProps) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	invalidate(): void {}

	private viewRows(): number {
		// header(1) + top border(1) + bottom border(1) + footer(1)
		return Math.max(1, this.props.rows - 4);
	}

	private maxScroll(): number {
		return Math.max(0, this.props.lines.length - this.viewRows());
	}

	private scrollTo(target: number): void {
		this.scrollTop = Math.max(0, Math.min(target, this.maxScroll()));
	}

	render(width: number): string[] {
		const { styles, lines } = this.props;
		this.scrollTo(this.scrollTop);

		const header = truncateToWidth(
			`${styles.primary(styles.bold(" Preview "))}${styles.dim(this.props.title)}`,
			width,
			"…",
		);

		const innerWidth = Math.max(1, width - 4);
		const viewRows = this.viewRows();
		const top = truncateToWidth(styles.primary(`┌${"─".repeat(Math.max(0, width - 2))}┐`), width, "");
		const bottom = truncateToWidth(styles.primary(`└${"─".repeat(Math.max(0, width - 2))}┘`), width, "");

		const body: string[] = [];
		for (let i = 0; i < viewRows; i++) {
			const raw = lines[this.scrollTop + i] ?? "";
			body.push(`${styles.primary("│ ")}${fitExactly(raw, innerWidth)}${styles.primary(" │")}`);
		}

		const footer = this.renderFooter(width, viewRows);
		return [header, top, ...body, bottom, footer];
	}

	private renderFooter(width: number, viewRows: number): string {
		const { styles, lines } = this.props;
		const total = lines.length;
		const maxScroll = Math.max(0, total - viewRows);
		const pct = maxScroll === 0 ? 100 : Math.round((this.scrollTop / maxScroll) * 100);
		const from = total === 0 ? 0 : this.scrollTop + 1;
		const to = Math.min(total, this.scrollTop + viewRows);
		const position = styles.faint(` ${from}-${to} / ${total} (${pct}%) `);
		const keys = truncateToWidth(
			` ${styles.primary(styles.bold("↑↓"))} ${styles.dim("line")}  ${styles.primary(styles.bold("PgUp/PgDn"))} ${styles.dim("page")}  ${styles.primary(styles.bold("g/G"))} ${styles.dim("top/bottom")}  ${styles.primary(styles.bold("Q/Esc/Ctrl+E"))} ${styles.dim("close")}`,
			width,
			"…",
		);
		const leftW = visibleWidth(keys);
		const rightW = visibleWidth(position);
		if (leftW + 2 + rightW <= width) return `${keys}${" ".repeat(width - leftW - rightW)}${position}`;
		return keys;
	}

	handleInput(data: string): void {
		const visible = this.viewRows();
		const ch = printableKey(data);
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+e") || ch.toLowerCase() === "q") {
			this.props.onClose();
			return;
		}
		if (matchesKey(data, "up") || ch === "k") this.scrollTo(this.scrollTop - 1);
		else if (matchesKey(data, "down") || ch === "j") this.scrollTo(this.scrollTop + 1);
		else if (matchesKey(data, "pageUp") || ch === " ") this.scrollTo(this.scrollTop - Math.max(1, visible - 1));
		else if (matchesKey(data, "pageDown")) this.scrollTo(this.scrollTop + Math.max(1, visible - 1));
		else if (matchesKey(data, "home") || ch === "g") this.scrollTo(0);
		else if (matchesKey(data, "end") || ch === "G") this.scrollTo(this.maxScroll());
	}
}
