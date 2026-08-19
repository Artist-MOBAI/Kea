import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { searchArxiv } from "./arxiv.ts";
import { searchSemanticScholar } from "./semanticscholar.ts";

const searchParameters = Type.Object({
	query: Type.String(),
	max_results: Type.Optional(Type.Number({ description: "per source (default 8)" })),
});

export function createSearchLiteratureTool() {
	return {
		name: "search_literature",
		label: "Search literature",
		description: [
			"Search arXiv + Semantic Scholar in parallel; returns titles, abstracts, DOIs.",
			"Every downstream claim must cite a DOI this search returned — never from memory.",
		].join(" "),
		parameters: searchParameters,
		executionMode: "sequential",
		async execute(_id: string, params: Static<typeof searchParameters>) {
			const limit = Math.max(1, Math.min(params.max_results ?? 8, 30));
			const results = await Promise.allSettled([
				searchArxiv({ search: params.query, maxResults: limit }),
				searchSemanticScholar(params.query, limit),
			]);

			const lines: string[] = [];
			const seen = new Set<string>();
			const arxiv = results[0];
			if (arxiv?.status === "fulfilled") {
				for (const p of arxiv.value) {
					const key = (p.doi ?? p.arxivId).toLowerCase();
					if (seen.has(key)) continue;
					seen.add(key);
					lines.push(
						`- [arXiv:${p.arxivId}] ${p.title} (${p.published ?? "?"}) doi:${p.doi ?? "n/a"}\n  ${p.abstract.slice(0, 300)}`,
					);
				}
			}
			const s2 = results[1];
			if (s2?.status === "fulfilled") {
				for (const p of s2.value) {
					const doi = p.externalIds?.DOI;
					const key = (doi ?? p.paperId).toLowerCase();
					if (seen.has(key)) continue;
					seen.add(key);
					lines.push(
						`- [S2:${p.paperId.slice(0, 8)}] ${p.title ?? "?"} (${p.year ?? "?"}) doi:${doi ?? "n/a"}\n  ${(p.abstract ?? "").slice(0, 300)}`,
					);
				}
			}
			if (lines.length === 0) {
				const reasons = [
					arxiv?.status === "rejected" ? `arXiv: ${arxiv.reason}` : "",
					s2?.status === "rejected" ? `S2: ${s2.reason}` : "",
				]
					.filter(Boolean)
					.join("; ");
				return {
					content: [{ type: "text", text: `No results.${reasons ? ` (${reasons})` : ""}` }],
					details: { count: 0 },
				};
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: { count: lines.length } };
		},
	};
}
