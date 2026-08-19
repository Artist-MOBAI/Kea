import { describe, expect, test } from "vitest";
import { type ProbeOpenAiModelsResult, probeOpenAiModels } from "../src/provider-probe.ts";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function failReason(result: ProbeOpenAiModelsResult): string {
	if (result.ok) throw new Error("expected probe failure");
	return result.reason;
}

describe("probeOpenAiModels (fake fetch injected)", () => {
	test("ok: GET {baseUrl}/models + Bearer auth, maps data[].id", async () => {
		let seenUrl = "";
		let seenAuth = "";
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			seenUrl = String(url);
			seenAuth = String(((init?.headers ?? {}) as Record<string, string>).authorization);
			return jsonResponse(200, { data: [{ id: "gpt-x" }, { id: "gpt-y" }] });
		}) as unknown as typeof fetch;

		const result = await probeOpenAiModels("https://api.test/v1", "sk-abc", { fetchImpl });
		expect(result).toEqual({ ok: true, models: ["gpt-x", "gpt-y"] });
		expect(seenUrl).toBe("https://api.test/v1/models");
		expect(seenAuth).toBe("Bearer sk-abc");
	});

	test("401 → ok:false with status", async () => {
		const fetchImpl = (async () => jsonResponse(401, { error: "invalid key" })) as unknown as typeof fetch;
		const result = await probeOpenAiModels("https://api.test/v1", "sk-bad", { fetchImpl });
		expect(result).toMatchObject({ ok: false, status: 401 });
		expect(failReason(result)).toContain("401");
	});

	test("404 → status surfaced", async () => {
		const fetchImpl = (async () => jsonResponse(404, {})) as unknown as typeof fetch;
		const result = await probeOpenAiModels("https://api.test/v1", "k", { fetchImpl });
		expect(result).toMatchObject({ ok: false, status: 404 });
	});

	test("network error → ok:false with reason, no throw, no status", async () => {
		const fetchImpl = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		const result = await probeOpenAiModels("https://api.test/v1", "k", { fetchImpl });
		expect(result.ok).toBe(false);
		expect(failReason(result)).toContain("fetch failed");
		expect(result).not.toHaveProperty("status");
	});

	test("timeout → ok:false with reason explaining the timeout", async () => {
		// Hang until signal abort (AbortSignal.timeout rejects with TimeoutError)
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			return await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(init?.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
				});
			});
		}) as unknown as typeof fetch;
		const result = await probeOpenAiModels("https://api.test/v1", "k", { fetchImpl, timeoutMs: 30 });
		expect(result.ok).toBe(false);
		expect(failReason(result)).toContain("timed out");
	});

	test("200 but not JSON → ok:false", async () => {
		const fetchImpl = (async () => new Response("<html>nope</html>", { status: 200 })) as unknown as typeof fetch;
		const result = await probeOpenAiModels("https://api.test/v1", "k", { fetchImpl });
		expect(result.ok).toBe(false);
		expect(failReason(result)).toContain("not valid JSON");
	});

	test("200 but wrong shape → ok:false with the schema reason", async () => {
		const fetchImpl = (async () => jsonResponse(200, { items: [] })) as unknown as typeof fetch;
		const result = await probeOpenAiModels("https://api.test/v1", "k", { fetchImpl });
		expect(result.ok).toBe(false);
		expect(failReason(result)).toContain("unexpected /models shape");
	});

	test("body over the 1MB cap (content-length pre-check) → ok:false 'response too large'", async () => {
		const big = "x".repeat(2 * 1024 * 1024);
		const fetchImpl = (async () =>
			new Response(big, {
				status: 200,
				headers: { "content-length": String(big.length) },
			})) as unknown as typeof fetch;
		const result = await probeOpenAiModels("https://api.test/v1", "k", { fetchImpl });
		expect(result.ok).toBe(false);
		expect(failReason(result)).toBe("response too large");
	});

	test("body over cap (no content-length, streaming read capped) → 'response too large'", async () => {
		const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < 40; i++) controller.enqueue(chunk); // 2.5MB
				controller.close();
			},
		});
		const fetchImpl = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
		const result = await probeOpenAiModels("https://api.test/v1", "k", { fetchImpl });
		expect(result.ok).toBe(false);
		expect(failReason(result)).toBe("response too large");
	});

	test("chunked response without content-length (normal size) → parsed as usual", async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('{"data":[{"id":"sp'));
				controller.enqueue(encoder.encode('lit-model"}]}'));
				controller.close();
			},
		});
		const fetchImpl = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
		const result = await probeOpenAiModels("https://api.test/v1", "k", { fetchImpl });
		expect(result).toEqual({ ok: true, models: ["split-model"] });
	});

	test("no implicit baseUrl suffix cleanup: requested literally (caller normalizes)", async () => {
		let seenUrl = "";
		const fetchImpl = (async (url: string) => {
			seenUrl = String(url);
			return jsonResponse(200, { data: [] });
		}) as unknown as typeof fetch;
		await probeOpenAiModels("https://api.test/v1/chat/completions", "k", { fetchImpl });
		expect(seenUrl).toBe("https://api.test/v1/chat/completions/models");
	});
});
