import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { DARK_PALETTE, type ThemeStyles } from "../../src/tui/theme.ts";

type StyleFn = (s: string) => string;

const STYLE_KEYS = [
	"primary",
	"accent",
	"dim",
	"faint",
	"border",
	"success",
	"warning",
	"error",
	"userMark",
	"bold",
] as const;

type StyleKey = (typeof STYLE_KEYS)[number];

export function identityStyles(): ThemeStyles {
	const id: StyleFn = (s) => s;
	return {
		palette: DARK_PALETTE,
		primary: id,
		accent: id,
		dim: id,
		faint: id,
		border: id,
		success: id,
		warning: id,
		error: id,
		userMark: id,
		bold: id,
	};
}

const FULL_TAGS: Record<StyleKey, string> = {
	primary: "p",
	accent: "a",
	dim: "d",
	faint: "f",
	border: "bd",
	success: "ok",
	warning: "w",
	error: "e",
	userMark: "u",
	bold: "b",
};

export function tagStyles(tags: Partial<Record<StyleKey, string>> = FULL_TAGS): ThemeStyles {
	const styles = identityStyles();
	for (const key of STYLE_KEYS) {
		const tag = tags[key];
		if (tag !== undefined) styles[key] = (s) => `<${tag}>${s}</${tag}>`;
	}
	return styles;
}

const ansi =
	(code: string): StyleFn =>
	(s) =>
		`\x1b[${code}m${s}\x1b[0m`;

export function ansiStyles(): ThemeStyles {
	return {
		palette: DARK_PALETTE,
		primary: ansi("34"),
		accent: ansi("36"),
		dim: ansi("2"),
		faint: ansi("2"),
		border: ansi("2"),
		success: ansi("32"),
		warning: ansi("33"),
		error: ansi("31"),
		userMark: ansi("33"),
		bold: ansi("1"),
	};
}

export function identityMarkdownTheme(): MarkdownTheme {
	const id: StyleFn = (s) => s;
	return {
		heading: id,
		link: id,
		linkUrl: id,
		code: id,
		codeBlock: id,
		codeBlockBorder: id,
		quote: id,
		quoteBorder: id,
		hr: id,
		listBullet: id,
		bold: id,
		italic: id,
		strikethrough: id,
		underline: id,
	};
}
