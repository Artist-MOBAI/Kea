import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	sliceByColumn,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { CURSOR_REVERSE_ON, type ThemeStyles } from "../../theme.ts";

const EDITOR_PADDING_X = 4;

/** Highlights a leading `/token`; skipped when a reversed cursor is present to avoid splitting SGR. */
export function highlightFirstSlashToken(line: string, paint: (s: string) => string): string | undefined {
	if (line.includes(CURSOR_REVERSE_ON)) return undefined;
	const plain = stripTerminalSequences(line);
	const m = /^(\s*(?:>\s*)?)(\/[A-Za-z0-9?_-]*)/.exec(plain);
	if (!m) return undefined;
	const lead = m[1] ?? "";
	const token = m[2] ?? "";
	return line.slice(0, lead.length) + paint(token) + line.slice(lead.length + token.length);
}

// Wraps the pi-tui Editor's top/bottom horizontal rules into a full rounded box. Content rows get
// the side border only when col 0 / last col is plain space — protects cursor-reverse SGR cases.
export function wrapWithSideBorders(lines: string[], paint: (s: string) => string): string[] {
	let seenTop = false;
	return lines.map((line) => {
		const plain = stripTerminalSequences(line);
		if (plain.length > 0 && plain[0] === "─") {
			const leftCorner = seenTop ? "╰" : "╭";
			const rightCorner = seenTop ? "╯" : "╮";
			seenTop = true;
			if (plain.length === 1) return paint(leftCorner);
			const middle = plain.slice(1, -1);
			return paint(leftCorner + middle + rightCorner);
		}
		if (line.length === 0) return line;
		const firstCh = line[0];
		const lastCh = line.at(-1);
		const head = firstCh === " " ? paint("│") : (firstCh ?? "");
		const tail = line.length > 1 && lastCh === " " ? paint("│") : (lastCh ?? "");
		if (line.length === 1) return head;
		return head + line.slice(1, -1) + tail;
	});
}

// `    text` → `  > text`; returns undefined when the row has fewer than 4 leading spaces
// (paste marker / cursor overflow).
export function injectPromptSymbol(line: string, symbol = ">"): string | undefined {
	if (line.length < 4) return undefined;
	for (let i = 0; i < 4; i++) {
		if (line[i] !== " ") return undefined;
	}
	return `  ${symbol} ${line.slice(4)}`;
}

export interface RoundedEditorMeta {
	styles: ThemeStyles;
	argumentHints?: Map<string, string>;
}

export function ghostArgumentHint(text: string, hints: Map<string, string>): string | undefined {
	const m = /^\/([A-Za-z0-9?-]+) $/.exec(text);
	if (!m) return undefined;
	return hints.get(m[1] ?? "");
}

export class RoundedEditor extends Editor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		options?: EditorOptions,
		private readonly meta?: RoundedEditorMeta,
	) {
		super(tui, theme, { ...options, paddingX: EDITOR_PADDING_X });
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length >= 3) {
			let line = lines[1];
			if (line !== undefined) {
				const withPrompt = injectPromptSymbol(line);
				if (withPrompt !== undefined) {
					line = withPrompt;
					const text = this.getText();
					const meta = this.meta;
					if (text.startsWith("/") && meta) {
						const highlighted = highlightFirstSlashToken(line, (s) => meta.styles.primary(meta.styles.bold(s)));
						if (highlighted !== undefined) line = highlighted;
					}
					line = this.applyArgumentHint(line, width);
				}
				lines[1] = line;
			}
		}
		// Safety net: no row may exceed the width (pi-tui throws on over-width rows)
		return wrapWithSideBorders(lines, this.borderColor).map((l) => truncateToWidth(l, width));
	}

	private applyArgumentHint(line: string, width: number): string {
		const hint = this.argumentHintFor(this.getText());
		if (hint === undefined) return truncateToWidth(line, width);
		const firstLineLen = visibleWidth(this.getText().split("\n")[0] ?? "");
		// padding + "> " + typed text + cursor block
		const hintCol = this.getPaddingX() + 2 + firstLineLen + 1;
		const hintW = visibleWidth(hint);
		if (hintCol + hintW >= width) return truncateToWidth(line, width);
		const head = sliceByColumn(line, 0, hintCol);
		const pad = Math.max(0, width - hintCol - hintW);
		return truncateToWidth(`${head}${hint}${" ".repeat(pad)}`, width);
	}

	private argumentHintFor(text: string): string | undefined {
		const hints = this.meta?.argumentHints;
		if (!hints) return undefined;
		const hint = ghostArgumentHint(text, hints);
		return hint ? this.meta?.styles.dim(` ${hint}`) : undefined;
	}
}
