import { z } from "zod";

// OpenAI-compatible endpoint probe: validate baseUrl + key before persisting config. GET `{baseUrl}/models`
// (Bearer auth), never throws — network/TLS/timeout/parse failures all converge to { ok: false, reason },
// HTTP errors carry a status. Response body capped at 1MB (a /models list should never be larger; guards
// against mis-matched/malicious endpoints flooding memory). baseUrl is not path-sanitized: the caller passes
// the API root; a suffixed address makes the probe literally request `{baseUrl}/models` and fail honestly.

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 1024 * 1024;

const ModelsResponseSchema = z.object({
	data: z.array(z.object({ id: z.string() })),
});

export interface ProbeOpenAiModelsOptions {
	/** Test injection: replace the fetch implementation */
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export type ProbeOpenAiModelsResult = { ok: true; models: string[] } | { ok: false; status?: number; reason: string };

export async function probeOpenAiModels(
	baseUrl: string,
	apiKey: string,
	options: ProbeOpenAiModelsOptions = {},
): Promise<ProbeOpenAiModelsResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl}/models`, {
			method: "GET",
			headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		// when AbortSignal.timeout fires, fetch rejects with DOMException("TimeoutError")
		if (isAbortLike(err)) return { ok: false, reason: `timed out after ${timeoutMs}ms` };
		return { ok: false, reason: `request failed: ${reasonOf(err)}` };
	}

	if (!response.ok) {
		return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
	}

	// pre-check Content-Length when available; when missing (chunked), cap via streaming read
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
		return { ok: false, status: response.status, reason: "response too large" };
	}

	let body: string;
	try {
		body = await readCappedText(response, MAX_BODY_BYTES);
	} catch (err) {
		if (err instanceof BodyTooLargeError) return { ok: false, status: response.status, reason: "response too large" };
		return { ok: false, status: response.status, reason: `reading body failed: ${reasonOf(err)}` };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(body);
	} catch {
		return { ok: false, status: response.status, reason: "response is not valid JSON" };
	}

	const parsed = ModelsResponseSchema.safeParse(raw);
	if (!parsed.success) {
		return { ok: false, status: response.status, reason: `unexpected /models shape: ${z.prettifyError(parsed.error)}` };
	}
	return { ok: true, models: parsed.data.data.map((m) => m.id) };
}

class BodyTooLargeError extends Error {
	constructor() {
		super("response too large");
	}
}

/** Stream in chunks and cap: abort once accumulated bytes exceed cap, never pulling the whole response into memory. */
async function readCappedText(response: Response, capBytes: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return await response.text();
	const decoder = new TextDecoder();
	let text = "";
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > capBytes) {
			await reader.cancel().catch(() => {});
			throw new BodyTooLargeError();
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

function isAbortLike(err: unknown): boolean {
	return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function reasonOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
