import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { queryMaterial } from "./query.ts";

const parameters = Type.Object({
	formula: Type.Optional(Type.String({ description: "Reduced formula, e.g. Bi2Te3" })),
	elements: Type.Optional(Type.Array(Type.String())),
	nelements: Type.Optional(Type.Number()),
});

export function createQueryMaterialTool() {
	return {
		name: "query_material",
		label: "Query material",
		description: [
			"Query materials databases: Materials Project when MP_API_KEY is set, otherwise the OPTIMADE public endpoint.",
			"Every record carries provenance (db id + entry URL + methodology) — cite those when using the values.",
			"If sourceFailed=true, the data is unreachable: novelty judgments must be 'unverified', never 'novel'.",
			"Use it before novelty claims and to compare candidates against known phases.",
		].join(" "),
		parameters,
		executionMode: "sequential",
		async execute(_id: string, params: Static<typeof parameters>) {
			const result = await queryMaterial({
				formula: params.formula,
				elements: params.elements,
				nelements: params.nelements,
			});
			if (result.noCriteria) {
				return {
					content: [
						{
							type: "text",
							text: "No query criteria provided — supply formula (e.g. Bi2Te3) or elements/nelements.",
						},
					],
					details: { noCriteria: true },
					isError: true,
				};
			}
			if (result.sourceFailed) {
				return {
					content: [
						{
							type: "text",
							text: `Data source unreachable (${result.error ?? "?"}). Novelty verdict can only be unverified.`,
						},
					],
					details: { sourceFailed: true },
					isError: true,
				};
			}
			if (result.records.length === 0) {
				const note = result.error ? `\n[note] ${result.error}` : "";
				return {
					content: [
						{
							type: "text",
							text: `No matching records (source=${result.source}). Possible novel_candidate; must pass post-gates.${note}`,
						},
					],
					details: { count: 0, source: result.source },
				};
			}
			const lines = result.records.slice(0, 10).map((r) => {
				const props = Object.entries(r.properties)
					.map(([k, v]) => `${k}=${v}`)
					.join(", ");
				// provenance is Record<string, unknown>: read it honestly instead of casting first, then ??
				const entryUrl = typeof r.provenance.entry_url === "string" ? r.provenance.entry_url : "";
				return `- [${r.source}:${r.id}] ${r.formula ?? "?"} | ${props || "no properties"} | ${entryUrl}`;
			});
			if (result.error) lines.push(`[note] ${result.error}`);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { count: result.records.length, source: result.source },
			};
		},
	};
}
