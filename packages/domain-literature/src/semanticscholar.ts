import { fetchJson, fetchWithDeadline } from "@kea/research";
import { z } from "zod";

export const S2PaperSchema = z.object({
	paperId: z.string(),
	title: z.string().nullable(),
	abstract: z.string().nullable().optional(),
	year: z.number().nullable().optional(),
	externalIds: z.record(z.string(), z.string()).optional(),
	authors: z.array(z.object({ name: z.string() })).default([]),
	citationCount: z.number().optional(),
});
export type S2Paper = z.infer<typeof S2PaperSchema>;

const FIELDS = "paperId,title,abstract,year,externalIds,authors.name,citationCount";

export function buildS2SearchUrl(query: string, limit: number): string {
	const params = new URLSearchParams({ query, limit: String(limit), fields: FIELDS });
	return `https://api.semanticscholar.org/graph/v1/paper/search?${params.toString()}`;
}

export function buildS2DoiUrl(doi: string): string {
	return `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=${FIELDS}`;
}

export function mapS2Response(json: unknown): S2Paper[] {
	const parsed = z.object({ data: z.array(S2PaperSchema) }).safeParse(json);
	return parsed.success ? parsed.data.data : [];
}

export async function searchSemanticScholar(
	query: string,
	limit = 10,
	fetchImpl: typeof fetch = fetch,
): Promise<S2Paper[]> {
	const json = await fetchJson(
		buildS2SearchUrl(query, limit),
		{ headers: { Accept: "application/json" } },
		"Semantic Scholar",
		{ fetchImpl },
	);
	return mapS2Response(json);
}

export async function resolveDoi(doi: string, fetchImpl: typeof fetch = fetch): Promise<S2Paper | undefined> {
	const response = await fetchWithDeadline(
		buildS2DoiUrl(doi),
		{ headers: { Accept: "application/json" } },
		{ fetchImpl },
	);
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`Semantic Scholar DOI lookup ${response.status}`);
	const parsed = S2PaperSchema.safeParse(await response.json());
	return parsed.success ? parsed.data : undefined;
}
