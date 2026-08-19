import { fetchWithDeadline } from "@kea/research";
import { z } from "zod";

export const CrossrefWorkSchema = z.object({
	DOI: z.string(),
	title: z.array(z.string()).default([]),
	"container-title": z.array(z.string()).default([]),
	published: z.object({ "date-parts": z.array(z.array(z.number())).optional() }).optional(),
});
export type CrossrefWork = z.infer<typeof CrossrefWorkSchema>;

const CrossrefEnvelopeSchema = z.object({ message: CrossrefWorkSchema });

export function buildCrossrefUrl(doi: string): string {
	return `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
}

export async function lookupDoi(doi: string, fetchImpl: typeof fetch = fetch): Promise<CrossrefWork | undefined> {
	const response = await fetchWithDeadline(
		buildCrossrefUrl(doi),
		{ headers: { "User-Agent": "kea/0.1 (mailto:research@example.org)" } },
		{ fetchImpl },
	);
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`Crossref ${response.status}`);
	const parsed = CrossrefEnvelopeSchema.safeParse(await response.json());
	return parsed.success ? parsed.data.message : undefined;
}
