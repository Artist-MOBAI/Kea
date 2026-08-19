// Flat semantic tokens, each with a clear consumer; userMark is the only role hue. Section card
// frame color carries type semantics: border base → accent only while in progress → error on failure.
interface ColorPalette {
	/** Action color: tool names, mode badges, selected prefix, links */
	primary: string;
	/** Accent color: running indicator, METRIC highlight, inline code */
	accent: string;
	text: string;
	textDim: string;
	textFaint: string;
	/** Border (editor, box layout; base color of the section card frame) */
	border: string;
	success: string;
	/** Warning: auto mode, awaiting_human, waiting */
	warning: string;
	/** Error: ✗, yolo mode, danger marks */
	error: string;
	/** Dedicated hue for user messages (the only role color) */
	userMark: string;
}

export const DARK_PALETTE: ColorPalette = {
	primary: "#4fa8ff",
	accent: "#5bc0be",
	text: "#e0e0e0",
	textDim: "#888888",
	textFaint: "#6b6b6b",
	border: "#5a5a5a",
	success: "#4ec87e",
	warning: "#e8a838",
	error: "#e85454",
	userMark: "#e8b45a",
};

/** ANSI inverse-video SGR (cursor block): rounded-editor detects the cursor's presence via this (to avoid splitting SGR). */
export const CURSOR_REVERSE_ON = "\x1b[7m";

function colorEnabled(): boolean {
	if (process.env.NO_COLOR) return false;
	if (!process.stdout.isTTY) return false;
	return process.env.TERM !== "dumb";
}

function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)];
}

function ansi(hex: string): (s: string) => string {
	if (!colorEnabled()) return (s) => s;
	const [r, g, b] = hexToRgb(hex);
	return (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}

export interface ThemeStyles {
	palette: ColorPalette;
	primary: (s: string) => string;
	accent: (s: string) => string;
	dim: (s: string) => string;
	faint: (s: string) => string;
	border: (s: string) => string;
	success: (s: string) => string;
	warning: (s: string) => string;
	error: (s: string) => string;
	userMark: (s: string) => string;
	bold: (s: string) => string;
	/** Markdown decorations (ANSI attributes, palette-independent); absent = render as-is. */
	italic?: (s: string) => string;
	strikethrough?: (s: string) => string;
	underline?: (s: string) => string;
}

export function createTheme(): ThemeStyles {
	const palette = DARK_PALETTE;
	const ansiAttr = (code: number): ((s: string) => string) =>
		colorEnabled() ? (s: string) => `\x1b[${code}m${s}\x1b[0m` : (s: string) => s;
	return {
		palette,
		primary: ansi(palette.primary),
		accent: ansi(palette.accent),
		dim: ansi(palette.textDim),
		faint: ansi(palette.textFaint),
		border: ansi(palette.border),
		success: ansi(palette.success),
		warning: ansi(palette.warning),
		error: ansi(palette.error),
		userMark: ansi(palette.userMark),
		bold: ansiAttr(1),
		italic: ansiAttr(3),
		underline: ansiAttr(4),
		strikethrough: ansiAttr(9),
	};
}
