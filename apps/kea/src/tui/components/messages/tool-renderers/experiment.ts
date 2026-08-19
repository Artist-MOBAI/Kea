import { previewBodyLines } from "./generic.ts";
import type { RendererContext, ToolRenderer } from "./shared.ts";

const METRIC_LINE = /^\s*METRIC\s+[A-Za-z0-9_.-]+=/;

interface ExperimentDetails {
	jobId?: string;
	backend?: string;
	state?: string;
	rejected?: boolean;
}

function detailsOf(ctx: RendererContext): ExperimentDetails {
	return typeof ctx.details === "object" && ctx.details !== null ? (ctx.details as ExperimentDetails) : {};
}

export const experimentRenderer: ToolRenderer = {
	chips(ctx: RendererContext): string[] {
		const details = detailsOf(ctx);
		const chips: string[] = [];
		if (details.rejected) chips.push("budget-blocked");
		if (details.backend) chips.push(details.backend);
		if (details.jobId) chips.push(`job ${details.jobId.slice(0, 8)}`);
		if (details.state) chips.push(details.state);
		return chips;
	},
	bodyLines(ctx: RendererContext): string[] {
		return previewBodyLines(ctx, (line) =>
			METRIC_LINE.test(line) ? ctx.styles.accent(ctx.styles.bold(line.trim())) : undefined,
		);
	},
};
