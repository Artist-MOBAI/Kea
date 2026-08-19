import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
	buildCustomProvider,
	CUSTOM_PROVIDER_APIS,
	CustomModelsFileSchema,
	CustomProviderSchema,
	createModelsCollection,
	listModels,
	loadCustomProvidersConfig,
	registerCustomModels,
} from "../src/models.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

const VALID_PROVIDER = {
	id: "mylab",
	baseUrl: "https://api.mylab.ai/v1",
	apiKeyEnv: "MYLAB_API_KEY",
	models: [{ id: "researcher-72b", contextWindow: 65536 }],
};

describe("custom model config (TUI model UX)", () => {
	test("schema: defaults and invalid inputs", () => {
		const parsed = CustomProviderSchema.parse(VALID_PROVIDER);
		expect(parsed.models[0]?.contextWindow).toBe(65536);
		expect(parsed.models[0]?.maxTokens).toBe(8192);
		expect(() => CustomProviderSchema.parse({ ...VALID_PROVIDER, id: "My Lab!" })).toThrow();
		expect(() => CustomProviderSchema.parse({ ...VALID_PROVIDER, baseUrl: "not-a-url" })).toThrow();
		expect(() => CustomProviderSchema.parse({ ...VALID_PROVIDER, models: [] })).toThrow();
	});

	test("schema: baseUrl restricted to http(s) — file:// and gopher:// rejected, localhost/IP allowed", () => {
		expect(() => CustomProviderSchema.parse({ ...VALID_PROVIDER, baseUrl: "file:///etc/passwd" })).toThrow();
		expect(() => CustomProviderSchema.parse({ ...VALID_PROVIDER, baseUrl: "gopher://x.example/" })).toThrow();
		expect(CustomProviderSchema.parse({ ...VALID_PROVIDER, baseUrl: "http://localhost:8080/v1" }).baseUrl).toBe(
			"http://localhost:8080/v1",
		);
		expect(CustomProviderSchema.parse({ ...VALID_PROVIDER, baseUrl: "http://127.0.0.1:4000" }).baseUrl).toBe(
			"http://127.0.0.1:4000",
		);
	});

	test('schema: baseUrl trailing slash stripped (hand-written "…/v1/" does not probe as "…/v1//models")', () => {
		expect(CustomProviderSchema.parse({ ...VALID_PROVIDER, baseUrl: "https://api.mylab.ai/v1/" }).baseUrl).toBe(
			"https://api.mylab.ai/v1",
		);
		expect(CustomProviderSchema.parse({ ...VALID_PROVIDER, baseUrl: "https://api.mylab.ai/v1///" }).baseUrl).toBe(
			"https://api.mylab.ai/v1",
		);
		const provider = buildCustomProvider(
			CustomProviderSchema.parse({ ...VALID_PROVIDER, baseUrl: "https://api.mylab.ai/v1//" }),
		);
		expect(provider.getModels()[0]?.baseUrl).toBe("https://api.mylab.ai/v1");
	});

	test("duplicate id within one models.json → first wins, later ones dropped + warn", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-cm-"));
		const path = join(workdir, ".kea", "models.json");
		await Bun.write(
			path,
			JSON.stringify({
				providers: [
					VALID_PROVIDER,
					{ ...VALID_PROVIDER, baseUrl: "https://evil.example/v1", models: [{ id: "zz-dup" }] },
				],
			}),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const configs = await loadCustomProvidersConfig(workdir);
			expect(configs).toHaveLength(1);
			expect(configs[0]?.baseUrl).toBe("https://api.mylab.ai/v1");
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain("duplicate");

			const models = createModelsCollection();
			expect(await registerCustomModels(workdir, models)).toEqual(["mylab"]);
			expect(models.getModel("mylab", "zz-dup")).toBeUndefined();
			expect(models.getModel("mylab", "researcher-72b")).toBeDefined();
		} finally {
			warn.mockRestore();
		}
	});

	test("missing file → empty config (silent); invalid JSON → empty config + one warn (tolerant)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-cm-"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(await loadCustomProvidersConfig(workdir)).toEqual([]);
			expect(warn).not.toHaveBeenCalled();
			const path = join(workdir, ".kea", "models.json");
			await Bun.write(path, "{broken");
			expect(await loadCustomProvidersConfig(workdir)).toEqual([]);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	test("invalid schema → empty config + one warn", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-cm-"));
		await Bun.write(
			join(workdir, ".kea", "models.json"),
			JSON.stringify({ providers: [{ id: "My Lab!", baseUrl: "not-a-url", apiKeyEnv: "K", models: [] }] }),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(await loadCustomProvidersConfig(workdir)).toEqual([]);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	test("buildCustomProvider yields an OpenAI-compatible provider", () => {
		const provider = buildCustomProvider(CustomProviderSchema.parse(VALID_PROVIDER));
		expect(provider.id).toBe("mylab");
		const models = provider.getModels();
		expect(models).toHaveLength(1);
		expect(models[0]?.api).toBe("openai-completions");
		expect(models[0]?.baseUrl).toBe("https://api.mylab.ai/v1");
	});

	test("registerCustomModels: built-in provider id conflict → skip + warn, built-ins not hijacked", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-cm-"));
		await Bun.write(
			join(workdir, ".kea", "models.json"),
			JSON.stringify({
				providers: [
					{ id: "anthropic", baseUrl: "https://evil.example/v1", apiKeyEnv: "X", models: [{ id: "zz-hijack" }] },
					VALID_PROVIDER,
				],
			}),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const models = createModelsCollection();
			const registered = await registerCustomModels(workdir, models);
			expect(registered).toEqual(["mylab"]);
			expect(warn).toHaveBeenCalledTimes(1);
			// built-in anthropic provider stays intact: the hijacked model is not registered, real built-in models still resolve
			expect(models.getModel("anthropic", "zz-hijack")).toBeUndefined();
			expect(models.getModel("anthropic", "claude-sonnet-4-5")).toBeDefined();
		} finally {
			warn.mockRestore();
		}
	});

	test("schema: api defaults to openai-completions, all three variants accepted, invalid api rejected", () => {
		expect(CustomProviderSchema.parse(VALID_PROVIDER).api).toBe("openai-completions");
		for (const api of CUSTOM_PROVIDER_APIS) {
			expect(CustomProviderSchema.parse({ ...VALID_PROVIDER, api }).api).toBe(api);
		}
		expect(() => CustomProviderSchema.parse({ ...VALID_PROVIDER, api: "grpc" })).toThrow();
	});

	test("schema: apiKeyEnv optional (old models.json compat; omitted = stored-credential-only provider)", () => {
		const { apiKeyEnv: _omit, ...rest } = VALID_PROVIDER;
		const parsed = CustomProviderSchema.parse(rest);
		expect(parsed.apiKeyEnv).toBeUndefined();
	});

	test("buildCustomProvider: each api variant registers with its wire API", () => {
		for (const api of CUSTOM_PROVIDER_APIS) {
			const provider = buildCustomProvider(CustomProviderSchema.parse({ ...VALID_PROVIDER, api }));
			const models = provider.getModels();
			expect(models).toHaveLength(1);
			expect(models[0]?.api).toBe(api);
			expect(models[0]?.baseUrl).toBe("https://api.mylab.ai/v1");
		}
	});

	test("auth.resolve: apiKeyEnv falls back to env; omitted/unset → undefined (stored-credential only)", async () => {
		const signal = new AbortController().signal;
		const ctxWithKey: AuthContext = {
			env: async (name) => (name === "MYLAB_API_KEY" ? "sk-from-env" : undefined),
			fileExists: async () => false,
		};
		const ctxNoKey: AuthContext = { env: async () => undefined, fileExists: async () => false };

		const withEnv = buildCustomProvider(CustomProviderSchema.parse(VALID_PROVIDER));
		await expect(withEnv.auth.apiKey?.resolve({ ctx: ctxWithKey, signal })).resolves.toEqual({
			auth: { apiKey: "sk-from-env" },
			source: "MYLAB_API_KEY",
		});
		await expect(withEnv.auth.apiKey?.resolve({ ctx: ctxNoKey, signal })).resolves.toBeUndefined();

		const storedOnly = buildCustomProvider(CustomProviderSchema.parse({ ...VALID_PROVIDER, apiKeyEnv: undefined }));
		await expect(storedOnly.auth.apiKey?.resolve({ ctx: ctxWithKey, signal })).resolves.toBeUndefined();

		// Stored credential: pi passes the credential read from CredentialStore into resolve(), and the provider consumes it first
		const credential = { type: "api_key", key: "sk-stored" } as const;
		await expect(withEnv.auth.apiKey?.resolve({ ctx: ctxNoKey, credential, signal })).resolves.toEqual({
			auth: { apiKey: "sk-stored" },
			source: "stored credential",
		});
		// Stored credential wins over the environment variable
		await expect(withEnv.auth.apiKey?.resolve({ ctx: ctxWithKey, credential, signal })).resolves.toEqual({
			auth: { apiKey: "sk-stored" },
			source: "stored credential",
		});
		await expect(storedOnly.auth.apiKey?.resolve({ ctx: ctxNoKey, credential, signal })).resolves.toEqual({
			auth: { apiKey: "sk-stored" },
			source: "stored credential",
		});
	});

	test("models registered via registerCustomModels are resolvable/listable", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-cm-"));
		const path = join(workdir, ".kea", "models.json");
		await Bun.write(path, JSON.stringify(CustomModelsFileSchema.parse({ providers: [VALID_PROVIDER] })));

		const models = createModelsCollection();
		const registered = await registerCustomModels(workdir, models);
		expect(registered).toEqual(["mylab"]);

		const specs = listModels(models).map((m) => m.spec);
		expect(specs).toContain("mylab/researcher-72b");

		await registerCustomModels(workdir, models);
		expect(listModels(models).filter((m) => m.spec === "mylab/researcher-72b")).toHaveLength(1);
	});
});
