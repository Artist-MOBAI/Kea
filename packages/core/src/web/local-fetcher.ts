import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { type FetchImpl, HttpFetchError, type UrlFetcher, type UrlFetchResult } from "./types.ts";

/**
 * Local URL fetcher (FetchURL's always-present fallback implementation, Bun-native).
 *
 * Safety baseline (SSRF protection):
 * - scheme restricted to http/https;
 * - private/loopback/link-local/ULA ranges blocked (BlockList);
 * - hostname DNS-resolved first, every answer checked against BlockList;
 * - manual redirects (≤10 hops), full re-validation of the new URL on each hop.
 *
 * Known trade-off: Bun fetch cannot pin a resolved IP at the socket layer the way undici can,
 * so there is a theoretical DNS-rebinding window between validation and connect (kimi uses Node/undici to eliminate it).
 * This is the current best under the Bun stack — documented rather than pretended away.
 */

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Kea/0.1";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const DEFAULT_TIMEOUT_MS = 30_000;

function buildBlockList(): BlockList {
	const list = new BlockList();
	list.addSubnet("10.0.0.0", 8);
	list.addSubnet("172.16.0.0", 12);
	list.addSubnet("192.168.0.0", 16);
	list.addSubnet("127.0.0.0", 8);
	list.addSubnet("169.254.0.0", 16);
	list.addSubnet("100.64.0.0", 10);
	list.addSubnet("0.0.0.0", 8);
	list.addAddress("::1", "ipv6");
	list.addSubnet("fc00::", 7, "ipv6");
	list.addSubnet("fe80::", 10, "ipv6");
	// note: do not add the ::ffff:0:0/96 range — BlockList.check already matches both IPv4 and mapped-IPv6 forms,
	// adding it explicitly would classify every IPv4 as private.
	return list;
}

const BLOCKED = buildBlockList();

export function isPrivateAddress(ip: string): boolean {
	const version = isIP(ip) === 6 ? "ipv6" : "ipv4";
	return BLOCKED.check(ip, version);
}

export async function validateHost(hostname: string): Promise<void> {
	const lower = hostname.toLowerCase();
	if (lower === "localhost" || lower.endsWith(".localhost")) {
		throw new Error(`blocked host: ${hostname} (loopback name)`);
	}
	if (isIP(hostname)) {
		if (isPrivateAddress(hostname)) throw new Error(`blocked address: ${hostname} (private/loopback/link-local)`);
		return;
	}
	const answers = await lookup(hostname, { all: true });
	if (answers.length === 0) throw new Error(`DNS resolution failed for ${hostname}`);
	for (const a of answers) {
		if (isPrivateAddress(a.address)) {
			throw new Error(`blocked address for ${hostname}: ${a.address} (private/loopback/link-local)`);
		}
	}
}

function validateScheme(url: URL): void {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`blocked scheme: ${url.protocol} (only http/https allowed)`);
	}
}

export interface LocalFetcherOptions {
	/** test injection: replace the fetch implementation */
	fetchImpl?: FetchImpl;
	/** test injection: disable private-address validation (tests only) */
	allowPrivateAddresses?: boolean;
	maxBytes?: number;
	timeoutMs?: number;
}

export function createLocalFetcher(options: LocalFetcherOptions = {}): UrlFetcher {
	const fetchImpl = options.fetchImpl ?? fetch;
	const maxBytes = options.maxBytes ?? MAX_BYTES;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	async function readBodyCapped(response: Response): Promise<string> {
		const contentLength = Number(response.headers.get("content-length") ?? Number.NaN);
		if (Number.isFinite(contentLength) && contentLength > maxBytes) {
			throw new Error(`response too large: ${contentLength} bytes (cap ${maxBytes})`);
		}
		// stream in chunks and abort once accumulated bytes exceed the cap: arrayBuffer() would buffer the
		// whole body (potentially ≫10MB) in memory before the size check ever runs
		const reader = response.body?.getReader();
		if (!reader) return await response.text();
		const decoder = new TextDecoder("utf-8", { fatal: false });
		let text = "";
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new Error(`response too large: ${size} bytes (cap ${maxBytes})`);
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	}

	return {
		async fetch(url: string, fetchOptions): Promise<UrlFetchResult> {
			let current = new URL(url);
			const callerSignal = fetchOptions?.signal;

			for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
				validateScheme(current);
				if (!options.allowPrivateAddresses) await validateHost(current.hostname);
				// merge the caller (agent) signal with the per-hop timeout: keeps the per-hop timeout budget while remaining upstream-interruptible
				const deadline = AbortSignal.timeout(timeoutMs);
				const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
				const response = await fetchImpl(current.toString(), {
					method: "GET",
					redirect: "manual",
					headers: { "user-agent": USER_AGENT, accept: "text/html,text/markdown,text/plain;q=0.9,*/*;q=0.5" },
					signal,
				});

				if (response.status >= 300 && response.status < 400) {
					const location = response.headers.get("location");
					if (!location) throw new Error(`redirect without location (status ${response.status})`);
					current = new URL(location, current);
					continue;
				}
				if (response.status >= 400) {
					throw new HttpFetchError(response.status, `HTTP ${response.status}`);
				}

				const contentType = response.headers.get("content-type") ?? "";
				const body = await readBodyCapped(response);
				if (contentType.includes("text/plain") || contentType.includes("text/markdown")) {
					return { content: body, kind: "passthrough" };
				}
				return { content: extractReadableText(body), kind: "extracted" };
			}
			throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
		},
	};
}

const DECODE_MAP: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
};

function safeFromCodePoint(cp: number): string {
	// out-of-range malicious/corrupt entities (e.g. &#x110000;) don't throw, degrade to the replacement character
	if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "\uFFFD";
	try {
		return String.fromCodePoint(cp);
	} catch {
		return "\uFFFD";
	}
}

function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
		.replace(/&([a-zA-Z]+);/g, (m, name: string) => DECODE_MAP[name.toLowerCase()] ?? m);
}

/** Extract readable text from HTML (linear-time single-pass scan).
 *
 * Safety requirement: fetch_url is auto-approved in all modes, so input is fully controlled by the remote page —
 * backtracking regexes (`[\s\S]*?` against unclosed tags) are quadratic ReDoS on malicious pages,
 * so everything here is index scanning: each character is consumed once, worst case O(n).
 */
const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "head", "title"]);
const BLOCK_CLOSE_TAGS = new Set([
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"p",
	"li",
	"div",
	"tr",
	"section",
	"article",
	"blockquote",
	"pre",
	"table",
]);

export function extractReadableText(html: string): string {
	const lower = html.toLowerCase();
	const n = html.length;

	// extract title first (linear indexOf, no backtracking)
	let title = "";
	const titleStart = lower.indexOf("<title");
	if (titleStart !== -1) {
		const contentStart = html.indexOf(">", titleStart + 6);
		if (contentStart !== -1) {
			const titleEnd = lower.indexOf("</title", contentStart + 1);
			const raw = titleEnd === -1 ? html.slice(contentStart + 1) : html.slice(contentStart + 1, titleEnd);
			title = decodeEntities(raw.replace(/\s+/g, " ").trim());
		}
	}

	let out = "";
	let i = 0;
	while (i < n) {
		const lt = html.indexOf("<", i);
		if (lt === -1) {
			out += html.slice(i);
			break;
		}
		if (lt > i) out += html.slice(i, lt);
		i = lt;

		if (html.startsWith("<!--", i)) {
			const end = html.indexOf("-->", i + 4);
			i = end === -1 ? n : end + 3;
			continue;
		}
		if (html.startsWith("<!", i)) {
			const end = html.indexOf(">", i + 2);
			i = end === -1 ? n : end + 1;
			continue;
		}

		const closing = html[i + 1] === "/";
		const nameStart = closing ? i + 2 : i + 1;
		let nameEnd = nameStart;
		while (nameEnd < n) {
			const ch = html[nameEnd] ?? "";
			if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9")) nameEnd += 1;
			else break;
		}
		const tagName = html.slice(nameStart, nameEnd).toLowerCase();
		if (tagName === "") {
			out += "<";
			i += 1;
			continue;
		}
		const tagGt = html.indexOf(">", nameEnd);
		const afterTag = tagGt === -1 ? n : tagGt + 1;

		if (closing) {
			if (BLOCK_CLOSE_TAGS.has(tagName)) out += "\n";
			i = afterTag;
			continue;
		}
		if (SKIP_TAGS.has(tagName)) {
			// jump to the matching close tag; if not found, swallow the remaining input (linear handling of unclosed tags)
			const closeIdx = lower.indexOf(`</${tagName}`, afterTag);
			i = closeIdx === -1 ? n : closeIdx;
			continue;
		}
		if (tagName === "br") out += "\n";
		else if (/^h[1-6]$/.test(tagName)) out += "\n";
		else if (tagName === "li") out += "- ";
		else out += " ";
		i = afterTag;
	}

	const text = decodeEntities(out);
	const lines = text
		.split("\n")
		.map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
		.filter((line) => line !== "");

	const body = lines.join("\n").trim();
	if (body === "") return title;
	return title !== "" ? `# ${title}\n\n${body}` : body;
}
