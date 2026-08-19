import { baseChip, type RendererContext, type ToolRenderer } from "./shared.ts";

function paintLine(ctx: RendererContext, line: string): string {
	return ctx.isError ? ctx.styles.error(line) : ctx.styles.dim(line);
}

// Preview is split into lines and colored (error red / normal dim). The optional highlight hook
// returns per-line custom coloring; a hit takes precedence over the default form.
export function previewBodyLines(ctx: RendererContext, highlight?: (line: string) => string | undefined): string[] {
	if (ctx.preview === "") return [];
	return ctx.preview.split("\n").map((line) => highlight?.(line) ?? paintLine(ctx, line));
}

export const genericRenderer: ToolRenderer = {
	chips(ctx: RendererContext): string[] {
		const chip = baseChip(ctx.name, ctx);
		return chip === "" ? [] : [chip];
	},
	bodyLines(ctx: RendererContext): string[] {
		return previewBodyLines(ctx);
	},
};
