import { type FetchImpl, HttpFetchError, type WebSearchProvider, type WebSearchResult } from "./types.ts";

/**
 * Search provider with a configurable endpoint: POST {query} → JSON.
 * Endpoint contract: response is { results: [...] } or a bare array; each item { title, url, snippet, date?, site_name|siteName? }.
 * Config: KEA_WEB_SEARCH_BASE_URL (required) + KEA_WEB_SEARCH_API_KEY (optional Bearer).
 */

export const WEB_SEARCH_BASE_URL_ENV = "KEA_WEB_SEARCH_BASE_URL";
export const WEB_SEARCH_API_KEY_ENV = "KEA_WEB_SEARCH_API_KEY";

export interface HttpSearchProviderOptions {
	baseUrl: string;
	apiKey?: string;
	fetchImpl?: FetchImpl;
	timeoutMs?: number;
}

export function createHttpSearchProvider(options: HttpSearchProviderOptions): WebSearchProvider {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? 30_000;
	return {
		async search(query, searchOptions) {
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
			// merge the caller (agent) signal with our own timeout: interruptible by upstream, while keeping the timeout budget
			const deadline = AbortSignal.timeout(timeoutMs);
			const signal = searchOptions?.signal ? AbortSignal.any([searchOptions.signal, deadline]) : deadline;
			const response = await fetchImpl(options.baseUrl, {
				method: "POST",
				headers,
				body: JSON.stringify({ query }),
				signal,
			});
			if (response.status >= 400) {
				throw new HttpFetchError(response.status, `search endpoint HTTP ${response.status}`);
			}
			const payload = (await response.json()) as { results?: unknown } | unknown[];
			const raw = Array.isArray(payload) ? payload : Array.isArray(payload.results) ? payload.results : [];
			const out: WebSearchResult[] = [];
			for (const item of raw) {
				if (typeof item !== "object" || item === null) continue;
				const r = item as Record<string, unknown>;
				const title = typeof r.title === "string" ? r.title : "";
				const url = typeof r.url === "string" ? r.url : typeof r.link === "string" ? r.link : "";
				if (title === "" || url === "") continue;
				out.push({
					title,
					url,
					snippet: typeof r.snippet === "string" ? r.snippet : typeof r.description === "string" ? r.description : "",
					date: typeof r.date === "string" && r.date !== "" ? r.date : undefined,
					siteName:
						typeof r.siteName === "string" && r.siteName !== ""
							? r.siteName
							: typeof r.site_name === "string" && r.site_name !== ""
								? r.site_name
								: undefined,
				});
			}
			return out;
		},
	};
}

/** Resolve a search provider from the environment; returns undefined when not configured (tool therefore not registered — activation gating). */
export function searchProviderFromEnv(
	env: Record<string, string | undefined> = process.env,
): WebSearchProvider | undefined {
	const baseUrl = env[WEB_SEARCH_BASE_URL_ENV];
	if (!baseUrl || !/^https?:\/\//.test(baseUrl)) return undefined;
	return createHttpSearchProvider({ baseUrl, apiKey: env[WEB_SEARCH_API_KEY_ENV] || undefined });
}
