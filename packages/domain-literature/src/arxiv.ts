import { fetchWithDeadline } from "@kea/research";
import { z } from "zod";

export interface ArxivQuery {
	search: string;
	maxResults?: number;
	sortBy?: "relevance" | "submittedDate";
}

export function buildArxivUrl(query: ArxivQuery): string {
	const params = new URLSearchParams({
		search_query: `all:${query.search}`,
		start: "0",
		max_results: String(query.maxResults ?? 10),
		sortBy: query.sortBy ?? "relevance",
	});
	return `https://export.arxiv.org/api/query?${params.toString()}`;
}

export const ArxivPaperSchema = z.object({
	arxivId: z.string(),
	title: z.string(),
	abstract: z.string(),
	authors: z.array(z.string()).default([]),
	published: z.string().optional(),
	url: z.string(),

	doi: z.string().optional(),
});
export type ArxivPaper = z.infer<typeof ArxivPaperSchema>;

/** Code points outside 0..0x10FFFF (or NaN) throw RangeError in String.fromCodePoint; malformed entities degrade to empty rather than failing the parse */
function safeFromCodePoint(value: number): string {
	if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
	try {
		return String.fromCodePoint(value);
	} catch {
		return "";
	}
}

function decodeEntities(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_, d: string) => safeFromCodePoint(Number(d)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => safeFromCodePoint(Number.parseInt(h, 16)))
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

function stripTags(xml: string): string {
	return decodeEntities(
		xml
			.replace(/<!\[CDATA\[|\]\]>/g, "")
			.replace(/<[^>]+>/g, "")
			.trim(),
	);
}

export function parseArxivAtom(xml: string): ArxivPaper[] {
	const papers: ArxivPaper[] = [];
	const entries = xml.split(/<entry>/).slice(1);
	for (const entry of entries) {
		const body = entry.split(/<\/entry>/)[0] ?? "";
		const idMatch = /<id>\s*([^<]+)\s*<\/id>/.exec(body);
		const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(body);
		const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(body);
		const publishedMatch = /<published>\s*([^<]+)\s*<\/published>/.exec(body);
		const doiMatch = /<arxiv:doi[^>]*>\s*([^<]+)\s*<\/arxiv:doi>/.exec(body);
		if (!idMatch?.[1] || !titleMatch?.[1]) continue;
		const rawUrl = idMatch[1].trim();
		const arxivId = rawUrl.split("/abs/").pop() ?? rawUrl;
		const authors = [...body.matchAll(/<name>\s*([^<]+)\s*<\/name>/g)].map((m) => (m[1] ?? "").trim());
		// safeParse gates each entry: malformed entries are skipped, not thrown (same fail-closed stance as the id/title continue)
		const parsed = ArxivPaperSchema.safeParse({
			arxivId: arxivId.replace(/v\d+$/, ""),
			title: stripTags(titleMatch[1]).replace(/\s+/g, " "),
			abstract: summaryMatch?.[1] ? stripTags(summaryMatch[1]).replace(/\s+/g, " ") : "",
			authors,
			published: publishedMatch?.[1]?.trim(),
			url: rawUrl,
			doi: doiMatch?.[1]?.trim(),
		});
		if (parsed.success) papers.push(parsed.data);
	}
	return papers;
}

export async function searchArxiv(query: ArxivQuery, fetchImpl: typeof fetch = fetch): Promise<ArxivPaper[]> {
	const response = await fetchWithDeadline(
		buildArxivUrl(query),
		{ headers: { "User-Agent": "kea/0.1 (research harness)" } },
		{ fetchImpl },
	);
	if (!response.ok) throw new Error(`arXiv API ${response.status}`);
	return parseArxivAtom(await response.text());
}
