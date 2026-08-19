import { describe, expect, test } from "vitest";
import { createLocalFetcher, extractReadableText, isPrivateAddress, validateHost } from "../src/web/local-fetcher.ts";
import { createHttpSearchProvider, searchProviderFromEnv } from "../src/web/search-provider.ts";
import { createFetchUrlTool, createWebSearchTool } from "../src/web/tools.ts";
import { HttpFetchError } from "../src/web/types.ts";

describe("SSRF guard", () => {
	test("private/loopback/link-local addresses are blocked", () => {
		expect(isPrivateAddress("127.0.0.1")).toBe(true);
		expect(isPrivateAddress("10.1.2.3")).toBe(true);
		expect(isPrivateAddress("172.16.0.1")).toBe(true);
		expect(isPrivateAddress("192.168.1.1")).toBe(true);
		expect(isPrivateAddress("169.254.169.254")).toBe(true);
		expect(isPrivateAddress("::1")).toBe(true);
		expect(isPrivateAddress("93.184.216.34")).toBe(false);
	});

	test("localhost hostnames are blocked", async () => {
		await expect(validateHost("localhost")).rejects.toThrow(/loopback/);
		await expect(validateHost("foo.localhost")).rejects.toThrow(/loopback/);
	});

	test("private-range IP literals are blocked", async () => {
		await expect(validateHost("169.254.169.254")).rejects.toThrow(/blocked/);
	});
});

describe("extractReadableText (lightweight body extraction)", () => {
	test("strips scripts/styles/tags, keeps the title and body", () => {
		const html =
			"<html><head><title>Page Title</title><style>body{}</style></head>" +
			"<body><script>evil()</script><h1>Head</h1><p>Hello &amp; world</p></body></html>";
		const text = extractReadableText(html);
		expect(text).toContain("# Page Title");
		expect(text).toContain("Head");
		expect(text).toContain("Hello & world");
		expect(text).not.toContain("evil");
		expect(text).not.toContain("body{}");
	});

	test("entity decoding (decimal/hex)", () => {
		expect(extractReadableText("<p>&#72;&#x69;</p>")).toContain("Hi");
	});

	test("an empty body falls back to the title", () => {
		expect(extractReadableText("<html><title>Only</title><body></body></html>")).toBe("Only");
	});

	test("hostile input: many unclosed script tags stay non-quadratic (ReDoS regression)", () => {
		const hostile = "<script".repeat(25_000); // ~200KB of unclosed tags
		const started = Date.now();
		const text = extractReadableText(hostile);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(1_000); // before the fix it measured ~7s with quadratic growth
		expect(text).toBe("");
	});

	test("hostile input: many unclosed comments are handled linearly", () => {
		const hostile = "<!--".repeat(25_000);
		const started = Date.now();
		extractReadableText(hostile);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test("out-of-range entities do not throw, degrading to the replacement char", () => {
		expect(() => extractReadableText("<p>&#x110000;</p>")).not.toThrow();
		expect(extractReadableText("<p>&#x110000;</p>")).toContain("\uFFFD");
	});
});

describe("createLocalFetcher", () => {
	const okResponse = (body: string, contentType: string) =>
		new Response(body, { status: 200, headers: { "content-type": contentType } });

	test("text/plain passthrough", async () => {
		const fetcher = createLocalFetcher({
			allowPrivateAddresses: true,
			fetchImpl: async () => okResponse("raw body", "text/plain"),
		});
		const result = await fetcher.fetch("http://example.com/a.txt");
		expect(result).toEqual({ content: "raw body", kind: "passthrough" });
	});

	test("HTML extraction (extracted)", async () => {
		const fetcher = createLocalFetcher({
			allowPrivateAddresses: true,
			fetchImpl: async () => okResponse("<html><title>T</title><body><p>content</p></body></html>", "text/html"),
		});
		const result = await fetcher.fetch("http://example.com/page");
		expect(result.kind).toBe("extracted");
		expect(result.content).toContain("# T");
		expect(result.content).toContain("content");
	});

	test("follows redirects and resolves relative Location", async () => {
		let calls = 0;
		const fetcher = createLocalFetcher({
			allowPrivateAddresses: true,
			fetchImpl: async (url) => {
				calls += 1;
				if (calls === 1) return new Response("", { status: 302, headers: { location: "/next" } });
				return okResponse(`final ${url}`, "text/plain");
			},
		});
		const result = await fetcher.fetch("http://example.com/start");
		expect(calls).toBe(2);
		expect(result.content).toContain("final http://example.com/next");
	});

	test("errors when the max redirect count is exceeded", async () => {
		const fetcher = createLocalFetcher({
			allowPrivateAddresses: true,
			fetchImpl: async () => new Response("", { status: 302, headers: { location: "/loop" } }),
		});
		await expect(fetcher.fetch("http://example.com/loop")).rejects.toThrow(/too many redirects/);
	});

	test("4xx throws HttpFetchError (with the status code)", async () => {
		const fetcher = createLocalFetcher({
			allowPrivateAddresses: true,
			fetchImpl: async () => new Response("nope", { status: 404 }),
		});
		await expect(fetcher.fetch("http://example.com/missing")).rejects.toMatchObject({ status: 404 });
	});

	test("byte cap", async () => {
		const fetcher = createLocalFetcher({
			allowPrivateAddresses: true,
			maxBytes: 8,
			fetchImpl: async () => okResponse("x".repeat(100), "text/plain"),
		});
		await expect(fetcher.fetch("http://example.com/big")).rejects.toThrow(/too large/);
	});

	test("private addresses rejected under default validation (fetch layer)", async () => {
		const fetcher = createLocalFetcher({ fetchImpl: async () => okResponse("x", "text/plain") });
		await expect(fetcher.fetch("http://169.254.169.254/latest")).rejects.toThrow(/blocked/);
	});

	test("non-http(s) schemes are rejected", async () => {
		const fetcher = createLocalFetcher({
			allowPrivateAddresses: true,
			fetchImpl: async () => okResponse("x", "text/plain"),
		});
		await expect(fetcher.fetch("file:///etc/passwd")).rejects.toThrow(/scheme/);
	});
});

describe("searchProviderFromEnv (activation gate)", () => {
	test("returns undefined when unconfigured", () => {
		expect(searchProviderFromEnv({})).toBeUndefined();
		expect(searchProviderFromEnv({ KEA_WEB_SEARCH_BASE_URL: "not-a-url" })).toBeUndefined();
	});

	test("returns a provider when a valid baseUrl is configured", () => {
		expect(searchProviderFromEnv({ KEA_WEB_SEARCH_BASE_URL: "https://search.example/api" })).toBeDefined();
	});
});

describe("fetch_url / web_search tool contract", () => {
	test("fetch_url: the result includes integrity notes and a citation reminder", async () => {
		const tool = createFetchUrlTool({ fetch: async () => ({ content: "body", kind: "passthrough" }) });
		const result = await tool.execute("id", { url: "http://x.com" });
		expect(result.content[0]?.text).toContain("full response body");
		expect(result.content[0]?.text).toContain("cite this page");
		expect(result.details).toMatchObject({ kind: "passthrough", chars: 4 });
	});

	test("fetch_url: errors classified into model-readable text (error branch throws, pi sets isError)", async () => {
		const tool = createFetchUrlTool({
			fetch: async () => {
				throw new HttpFetchError(500, "HTTP 500");
			},
		});
		await expect(tool.execute("id", { url: "http://x.com" })).rejects.toThrow("Failed to fetch URL. Status: 500.");
	});

	test("fetch_url: the agent signal is passed through to the fetch layer (merged with its own timeout)", async () => {
		let seen: AbortSignal | undefined;
		const fetcher = createLocalFetcher({
			allowPrivateAddresses: true,
			fetchImpl: async (_url, init) => {
				seen = init?.signal ?? undefined;
				return new Response("x", { status: 200, headers: { "content-type": "text/plain" } });
			},
		});
		const tool = createFetchUrlTool(fetcher);
		const controller = new AbortController();
		await tool.execute("id", { url: "http://example.com/a.txt" }, controller.signal);
		expect(seen).toBeDefined();
		expect(seen?.aborted).toBe(false);
		controller.abort();
		expect(seen?.aborted).toBe(true); // AbortSignal.any aborts when any input aborts
	});

	test("fetch_url: 50k truncation carries a marker", async () => {
		const tool = createFetchUrlTool({ fetch: async () => ({ content: "y".repeat(60_000), kind: "extracted" }) });
		const result = await tool.execute("id", { url: "http://x.com" });
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("[...truncated]");
		expect(text.length).toBeLessThan(60_000);
	});

	test("web_search: result block format and citation reminder", async () => {
		const tool = createWebSearchTool({
			search: async () => [{ title: "T1", url: "http://a.com", snippet: "s1", siteName: "A" }],
		});
		const result = await tool.execute("id", { query: "q" });
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Title: T1");
		expect(text).toContain("URL: http://a.com");
		expect(text).toContain("Site: A");
		expect(text).toContain("cite it inline");
		expect(result.details).toEqual({ count: 1 });
	});

	test("web_search: an empty result is a success (not an error)", async () => {
		const tool = createWebSearchTool({ search: async () => [] });
		const result = await tool.execute("id", { query: "q" });
		expect(result.content[0]?.text).toBe("No search results found.");
	});

	test("web_search: endpoint error classification (error branch throws, pi sets isError)", async () => {
		const tool = createWebSearchTool({
			search: async () => {
				throw new HttpFetchError(401, "HTTP 401");
			},
		});
		await expect(tool.execute("id", { query: "q" })).rejects.toThrow("Search failed: HTTP 401");
	});

	test("web_search: the agent signal is passed through to the provider (merged with its own timeout)", async () => {
		let seen: AbortSignal | undefined;
		const provider = createHttpSearchProvider({
			baseUrl: "https://search.example/api",
			fetchImpl: async (_url, init) => {
				seen = init?.signal ?? undefined;
				return new Response(JSON.stringify({ results: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});
		const tool = createWebSearchTool(provider);
		const controller = new AbortController();
		await tool.execute("id", { query: "q" }, controller.signal);
		expect(seen).toBeDefined();
		expect(seen?.aborted).toBe(false);
		controller.abort();
		expect(seen?.aborted).toBe(true);
	});
});
