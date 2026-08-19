/**
 * Web capability interfaces (decouples providers from tools; when capability is absent the tool is not registered — activation gating).
 */

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
	date?: string;
	siteName?: string;
}

export interface WebSearchProvider {
	search(query: string, options?: { toolCallId?: string; signal?: AbortSignal }): Promise<WebSearchResult[]>;
}

export type UrlFetchKind = "passthrough" | "extracted";

export interface UrlFetchResult {
	readonly content: string;
	readonly kind: UrlFetchKind;
}

export interface UrlFetcher {
	fetch(url: string, options?: { toolCallId?: string; signal?: AbortSignal }): Promise<UrlFetchResult>;
}

/** Injectable fetch implementation signature (narrower than typeof fetch: no Bun-specific preconnect, easy to mock in tests). */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** Upstream non-2xx: an error carrying the status code (tools render `Status: N`). */
export class HttpFetchError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "HttpFetchError";
	}
}
