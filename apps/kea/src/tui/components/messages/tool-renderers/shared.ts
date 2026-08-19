import type { ThemeStyles } from "../../../theme.ts";

export interface RendererContext {
	name: string;
	styles: ThemeStyles;
	args?: unknown;
	details?: unknown;
	preview: string;
	isError: boolean;
	durationMs: number;
}

/** Per-tool renderer: chips go into the header summary row, bodyLines are the pre-colored result preview rows. */
export interface ToolRenderer {
	chips(ctx: RendererContext): string[];
	bodyLines(ctx: RendererContext): string[];
}

export function objectOf(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function numberOf(value: unknown, key: string): number | undefined {
	const n = objectOf(value)[key];
	return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function countNonEmptyLines(text: string): number {
	if (text === "") return 0;
	let n = 0;
	for (const line of text.split("\n")) if (line.trim() !== "") n += 1;
	return n;
}

// pi edit contract: edits[] array (legacy top-level oldText/newText also accepted), not old_string/new_string.
function editStats(args: unknown): string {
	const a = objectOf(args);
	const edits: Array<{ oldText: string; newText: string }> = [];
	if (Array.isArray(a.edits)) {
		for (const e of a.edits) {
			const item = objectOf(e);
			if (typeof item.oldText === "string" && typeof item.newText === "string") {
				edits.push({ oldText: item.oldText, newText: item.newText });
			}
		}
	} else if (typeof a.oldText === "string" && typeof a.newText === "string") {
		edits.push({ oldText: a.oldText, newText: a.newText });
	}
	if (edits.length === 0) return "";
	let added = 0;
	let removed = 0;
	for (const ed of edits) {
		if (ed.oldText !== "") removed += ed.oldText.split("\n").length;
		if (ed.newText !== "") added += ed.newText.split("\n").length;
	}
	return `+${added} -${removed}`;
}

// write: content line count is a settled fact in the call args (details is undefined).
function writeStats(args: unknown): string {
	const content = objectOf(args).content;
	if (typeof content !== "string" || content === "") return "";
	return `${content.split("\n").length} lines`;
}

export function baseChip(name: string, ctx: RendererContext): string {
	const previewLines = countNonEmptyLines(ctx.preview);
	switch (name) {
		case "grep": {
			if (ctx.isError) return "";
			const matches = numberOf(ctx.details, "matches") ?? previewLines;
			return matches > 0 ? `${matches} matches` : "no matches";
		}
		case "glob": {
			if (ctx.isError) return "";
			const count = numberOf(ctx.details, "count") ?? previewLines;
			return count > 0 ? `${count} files` : "no files";
		}
		case "edit":
			return editStats(ctx.args);
		case "write":
			return writeStats(ctx.args);
		default:
			return previewLines > 0 ? `${previewLines} lines` : "";
	}
}
