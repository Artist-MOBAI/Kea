import { z } from "zod";
import { truncateWithMarker } from "../text.ts";
import { MAX_TOOL_RESULT_CHARS } from "../timeouts.ts";
import { HttpFetchError, type UrlFetcher, type WebSearchProvider } from "./types.ts";

/**
 * WebSearch / FetchURL tools (kimi result contract, Kea implementation):
 * - fixed result format: citation reminder, 50k-char truncation, empty result is success not error;
 * - errors classified into model-readable text (status-code / network).
 */

const MAX_RESULT_CHARS = MAX_TOOL_RESULT_CHARS;
const TRUNCATION_MARKER = "\n\n[...truncated]";

function truncate(text: string): string {
	return truncateWithMarker(text, MAX_RESULT_CHARS, TRUNCATION_MARKER);
}

function classifyFetchError(err: unknown): string {
	if (err instanceof HttpFetchError) return `Failed to fetch URL. Status: ${err.status}.`;
	const msg = err instanceof Error ? err.message : String(err);
	return `Failed to fetch URL due to network or security-check error: ${msg}`;
}

export const FETCH_URL_TOOL = "fetch_url";
export const WEB_SEARCH_TOOL = "web_search";

export function createFetchUrlTool(fetcher: UrlFetcher) {
	const parameters = z.strictObject({
		url: z.string().meta({ description: "The URL to fetch content from." }),
	});
	return {
		name: FETCH_URL_TOOL,
		label: "Fetch URL",
		description: [
			"Fetch content from a URL. The content is returned either as the main text extracted from the page, or as the full response body verbatim; a note at the top of the result states which of the two you received, so you can judge how complete it is.",
			"Use this when you need to read a specific web page.",
			"",
			"Only fully-formed public `http`/`https` URLs are supported; private or loopback addresses are not fetched.",
			"Very large pages may be truncated.",
			"The fetch carries no login or session for the target site, so pages behind authentication return a login page or an error instead of the real content — if the text you get back looks like a generic landing or sign-in page, treat that as the login wall, not the answer.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>, signal?: AbortSignal) {
			try {
				// pass the agent signal through to the fetcher (the fetcher merges it with its own timeout via AbortSignal.any)
				const result = await fetcher.fetch(params.url, { toolCallId: _id, signal });
				const note =
					result.kind === "passthrough"
						? "The returned content is the full response body, returned verbatim."
						: "The returned content is the main text extracted from the page.";
				const text = truncate(
					`${note}\nIf you use it in your answer, cite this page as a markdown link.\n\n${result.content}`,
				);
				return { content: [{ type: "text", text }], details: { kind: result.kind, chars: result.content.length } };
			} catch (err) {
				// pi tool error semantics: error branches always throw (returning isError is dropped by the framework)
				throw new Error(classifyFetchError(err));
			}
		},
	};
}

export function createWebSearchTool(provider: WebSearchProvider) {
	const parameters = z.strictObject({
		query: z.string().meta({ description: "The query text to search for." }),
	});
	return {
		name: WEB_SEARCH_TOOL,
		label: "Web search",
		description: [
			"Search the web and return a list of results (title, URL, snippet).",
			"Use this to find pages worth reading; results are summaries, not full content — follow up with fetch_url to read a specific page.",
			"When you rely on a result in your answer, cite it inline as a markdown link.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>, signal?: AbortSignal) {
			try {
				// pass the agent signal through to the provider (the provider merges it with its own timeout via AbortSignal.any)
				const results = await provider.search(params.query, { toolCallId: _id, signal });
				if (results.length === 0) {
					return { content: [{ type: "text", text: "No search results found." }], details: { count: 0 } };
				}
				const blocks = results.map((r) =>
					[
						`Title: ${r.title}`,
						r.siteName ? `Site: ${r.siteName}` : "",
						r.date ? `Date: ${r.date}` : "",
						`URL: ${r.url}`,
						`Snippet: ${r.snippet}`,
					]
						.filter((line) => line !== "")
						.join("\n"),
				);
				const text = truncate(
					`${blocks.join("\n\n---\n\n")}\n\nWhen you rely on a result in your answer, cite it inline as a markdown link, e.g. [title](url).`,
				);
				return { content: [{ type: "text", text }], details: { count: results.length } };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const text = err instanceof HttpFetchError ? `Search failed: ${msg}` : `Search failed (network): ${msg}`;
				throw new Error(text);
			}
		},
	};
}
