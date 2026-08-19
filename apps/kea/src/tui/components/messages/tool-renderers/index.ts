import { formatTokens } from "../../../constants/format.ts";
import { experimentRenderer } from "./experiment.ts";
import { genericRenderer } from "./generic.ts";
import { numberOf, objectOf, type ToolRenderer } from "./shared.ts";

export type { RendererContext, ToolRenderer } from "./shared.ts";
export { baseChip } from "./shared.ts";

const EXPERIMENT_TOOLS = new Set([
	"run_experiment",
	"evaluate_solution",
	"job_status",
	"job_cancel",
	"submit_experiment_result",
]);

// todo_list: the panel is the authoritative display; the card keeps only a header chip.
const todoRenderer: ToolRenderer = {
	chips(ctx) {
		if (ctx.isError) return [];
		// live uses result details.todos; transcript replay has no details, falls back to the call args.todos
		const todos = objectOf(ctx.details).todos ?? objectOf(ctx.args).todos;
		return Array.isArray(todos) ? [`${todos.length} items`] : [];
	},
	bodyLines() {
		return [];
	},
};

const webRenderer: ToolRenderer = {
	chips(ctx) {
		if (ctx.isError) return [];
		if (ctx.name === "fetch_url") {
			const chars = numberOf(ctx.details, "chars");
			return chars !== undefined ? [`${formatTokens(chars)} chars`] : [];
		}
		const count = numberOf(ctx.details, "count");
		if (count !== undefined) return count > 0 ? [`${count} results`] : ["no results"];
		return [];
	},
	bodyLines(ctx) {
		return genericRenderer.bodyLines(ctx);
	},
};

export function getToolRenderer(name: string): ToolRenderer {
	if (name === "todo_list") return todoRenderer;
	if (name === "fetch_url" || name === "web_search") return webRenderer;
	if (EXPERIMENT_TOOLS.has(name)) return experimentRenderer;
	return genericRenderer;
}
