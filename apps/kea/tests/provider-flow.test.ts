import { afterEach, describe, expect, test, vi } from "vitest";
import { SUCCESS_MARK } from "../src/tui/constants/symbols.ts";
import type { TUICtx } from "../src/tui/ctx.ts";
import { FilterablePicker, pickerTheme } from "../src/tui/picker.ts";
import { PromptStep } from "../src/tui/prompt-input.ts";
import { identityStyles } from "./helpers/styles.ts";
import { makeTempDir, removeTempDir } from "./helpers/temp-dir.ts";

// saveConfig spy: Alt+S session-level switch never lands in kea.toml (config spy semantics)
const { saveConfigSpy } = vi.hoisted(() => ({ saveConfigSpy: vi.fn(async (_path: string, _config: unknown) => {}) }));
vi.mock("../src/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/config.ts")>();
	return { ...actual, saveConfig: saveConfigSpy };
});

afterEach(() => {
	saveConfigSpy.mockClear();
});

describe("normalizeBaseUrl (custom endpoint normalization, pure function)", () => {
	test("trims whitespace and trailing slashes", async () => {
		const { normalizeBaseUrl } = await import("../src/tui/controllers/model-config.ts");
		expect(normalizeBaseUrl("  https://api.mylab.ai/v1/  ")).toEqual({ ok: true, url: "https://api.mylab.ai/v1" });
		expect(normalizeBaseUrl("http://localhost:8080///")).toEqual({ ok: true, url: "http://localhost:8080" });
	});

	test("warns (but accepts) when the URL ends with a request path", async () => {
		const { normalizeBaseUrl } = await import("../src/tui/controllers/model-config.ts");
		const warning = "Usually the base URL stops before this path — remove it unless your gateway requires it.";
		expect(normalizeBaseUrl("https://api.mylab.ai/v1/chat/completions")).toEqual({
			ok: true,
			url: "https://api.mylab.ai/v1/chat/completions",
			warning,
		});
		expect(normalizeBaseUrl("https://api.mylab.ai/v1/responses")).toMatchObject({ ok: true, warning });
	});

	test("rejects non-http(s) input", async () => {
		const { normalizeBaseUrl } = await import("../src/tui/controllers/model-config.ts");
		expect(normalizeBaseUrl("ftp://x.ai")).toEqual({ ok: false, error: "Must start with http:// or https://" });
		expect(normalizeBaseUrl("")).toEqual({ ok: false, error: "Must start with http:// or https://" });
		expect(normalizeBaseUrl("   /   ")).toEqual({ ok: false, error: "Must start with http:// or https://" });
	});

	test("rejects URLs containing whitespace or control characters (paste poisoning guard)", async () => {
		const { normalizeBaseUrl } = await import("../src/tui/controllers/model-config.ts");
		const error = "Must not contain whitespace or control characters";
		expect(normalizeBaseUrl("https://a b")).toEqual({ ok: false, error });
		expect(normalizeBaseUrl("https://a\nb")).toEqual({ ok: false, error });
		expect(normalizeBaseUrl("https://a\tb/v1")).toEqual({ ok: false, error });
	});
});

describe("custom provider file round-trip (.kea/models.json write/remove)", () => {
	test("write merges siblings, remove deletes only the target", async () => {
		const { removeCustomProviderEntry, writeCustomProviderEntry } = await import(
			"../src/tui/controllers/model-config.ts"
		);
		const dir = await makeTempDir("kea-provider-flow-");
		try {
			await writeCustomProviderEntry(dir, {
				id: "mylab",
				baseUrl: "https://api.mylab.ai/v1",
				api: "openai-responses",
				models: [{ id: "researcher-72b", contextWindow: 131072 }],
			});
			await writeCustomProviderEntry(dir, {
				id: "other",
				baseUrl: "https://api.other.ai/v1",
				apiKeyEnv: "OTHER_API_KEY",
				models: [{ id: "small-1b", contextWindow: 8192 }],
			});
			let file = (await Bun.file(`${dir}/.kea/models.json`).json()) as { providers: Array<Record<string, unknown>> };
			expect(file.providers.map((p) => p.id)).toEqual(["mylab", "other"]);
			const mylab = file.providers[0] as Record<string, unknown>;
			expect(mylab.api).toBe("openai-responses");
			expect("apiKeyEnv" in mylab).toBe(false);

			await removeCustomProviderEntry(dir, "mylab");
			file = (await Bun.file(`${dir}/.kea/models.json`).json()) as { providers: Array<Record<string, unknown>> };
			expect(file.providers.map((p) => p.id)).toEqual(["other"]);
			await removeCustomProviderEntry(dir, "mylab");
		} finally {
			await removeTempDir(dir);
		}
	});
});

function fakeCtx(messages: Array<Record<string, unknown>> = []) {
	const statuses: Array<{ text: string; tone?: string }> = [];
	const errors: string[] = [];
	let footerRefreshes = 0;
	const kernel = {
		model: { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200000 },
		agent: { state: { isStreaming: false, messages } },
		setModel(spec: string) {
			const idx = spec.indexOf("/");
			kernel.model = { provider: spec.slice(0, idx), id: spec.slice(idx + 1), contextWindow: 100000 };
			return kernel.model;
		},
	};
	const ctx = {
		kernel,
		showStatus: (text: string, tone?: string) => statuses.push({ text, tone }),
		showError: (text: string) => errors.push(text),
		refreshFooter: () => (footerRefreshes += 1),
		restoreEditor: () => {},
	};
	return { ctx: ctx as never as TUICtx, kernel, statuses, errors, footerRefreshes: () => footerRefreshes };
}

describe("applyModelSelection (/model switch targets)", () => {
	test("session-only switch applies the model but does NOT write kea.toml", async () => {
		const { applyModelSelection } = await import("../src/tui/controllers/model-config.ts");
		const { ctx, kernel, statuses } = fakeCtx();
		applyModelSelection(ctx, "openai/gpt-5", "anthropic/claude-sonnet-4-5", true);
		expect(kernel.model.provider).toBe("openai");
		expect(saveConfigSpy).not.toHaveBeenCalled();
		expect(statuses.map((s) => s.text)).toContain("Switched to openai/gpt-5 for this session only.");
	});

	test("persistent switch writes defaultModel and keeps the distinct status copy", async () => {
		const { applyModelSelection } = await import("../src/tui/controllers/model-config.ts");
		const { ctx, statuses } = fakeCtx();
		applyModelSelection(ctx, "openai/gpt-5", "anthropic/claude-sonnet-4-5", false);
		expect(saveConfigSpy).toHaveBeenCalledTimes(1);
		expect(saveConfigSpy.mock.calls[0]?.[1]).toEqual({ defaultModel: "openai/gpt-5" });
		expect(statuses.map((s) => s.text)).toContain("Switched default model: openai/gpt-5");
	});

	test("assistant history present → prompt cache warning line (Kimi precedent)", async () => {
		const { applyModelSelection } = await import("../src/tui/controllers/model-config.ts");
		const withHistory = fakeCtx([{ role: "assistant", content: [] }]);
		applyModelSelection(withHistory.ctx, "openai/gpt-5", "anthropic/claude-sonnet-4-5", true);
		expect(withHistory.statuses.map((s) => s.text)).toContain("Switching models invalidates the prompt cache.");

		const fresh = fakeCtx([{ role: "user", content: [] }]);
		applyModelSelection(fresh.ctx, "openai/gpt-5", "anthropic/claude-sonnet-4-5", true);
		expect(fresh.statuses.map((s) => s.text)).not.toContain("Switching models invalidates the prompt cache.");
	});

	test("refuses while streaming and for the already-current model", async () => {
		const { applyModelSelection } = await import("../src/tui/controllers/model-config.ts");
		const busy = fakeCtx();
		busy.kernel.agent.state.isStreaming = true;
		applyModelSelection(busy.ctx, "openai/gpt-5", "anthropic/claude-sonnet-4-5", true);
		expect(busy.statuses.map((s) => s.text)).toContain(
			"Cannot switch models while streaming — press Esc or Ctrl-C first.",
		);
		expect(saveConfigSpy).not.toHaveBeenCalled();

		const same = fakeCtx();
		applyModelSelection(same.ctx, "anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5", true);
		expect(same.statuses.map((s) => s.text)).toContain("Already the current model: anthropic/claude-sonnet-4-5");
	});
});

describe("Alt+S picker mechanism (FilterablePicker onKey extension seam)", () => {
	test("alt+s is consumed by the onKey hook and sees the highlighted item", () => {
		const styles = identityStyles();
		let picked: string | undefined;
		const picker = new FilterablePicker(
			[
				{ value: "a/one", label: "a/one" },
				{ value: "b/two", label: "b/two" },
			],
			pickerTheme(styles),
			{ onPick: () => {}, onCancel: () => {} },
			() => "header",
			12,
			styles.primary,
			(data) => {
				if (data !== "\x1bs") return false;
				picked = picker.getSelectedItem()?.value ?? undefined;
				return true;
			},
		);
		picker.handleInput("\x1b[B");
		picker.handleInput("\x1bs");
		expect(picked).toBe("b/two");
	});
});

describe("openProviderManager row collection (real FileCredentialStore, KEA_HOME isolation)", () => {
	test("env-sourced builtin + stored-key rows shown, unconfigured skipped, ← current marked", async () => {
		const { openProviderManager } = await import("../src/tui/controllers/model-config.ts");
		const { ProviderPanel } = await import("../src/tui/components/dialogs/provider-panel.ts");
		const { CURRENT_MARK } = await import("../src/tui/constants/symbols.ts");
		const home = await makeTempDir("kea-home-");
		const prevHome = process.env.KEA_HOME;
		process.env.KEA_HOME = home;
		try {
			await Bun.write(`${home}/.kea/auth.json`, JSON.stringify({ mylab: { type: "api_key", key: "sk-test" } }));
			const models = {
				getProviders: () => [
					{ id: "anthropic", getModels: () => [{ id: "claude-sonnet-4-5", contextWindow: 200000 }] },
					{ id: "openai", getModels: () => [] },
					{ id: "mylab", getModels: () => [{ id: "researcher-72b", contextWindow: 131072 }] },
				],
				getAuth: async (id: string) => {
					if (id === "anthropic") return { auth: { apiKey: "x" }, source: "ANTHROPIC_API_KEY" };
					if (id === "mylab") return { auth: { apiKey: "y" }, source: "stored credential" };
					return undefined;
				},
			};
			const mounted: unknown[] = [];
			const ctx = {
				kernel: {
					model: { provider: "anthropic", id: "claude-sonnet-4-5" },
					models,
					agent: { state: { isStreaming: false } },
				},
				styles: () => identityStyles(),
				mountDialog: (component: unknown) => mounted.push(component),
				restoreEditor: () => {},
				showStatus: () => {},
				showError: () => {},
				tui: { requestRender: () => {} },
			};
			openProviderManager(ctx as never as TUICtx);
			await new Promise((resolve) => setTimeout(resolve, 20));
			const panel = mounted[0];
			expect(panel).toBeInstanceOf(ProviderPanel);
			const text = (panel as InstanceType<typeof ProviderPanel>).render(120).join("\n");
			expect(text).toContain("anthropic");
			expect(text).toContain("ANTHROPIC_API_KEY");
			expect(text).toContain(CURRENT_MARK);
			expect(text).toContain("mylab");
			expect(text).toContain("stored key");
			expect(text).not.toContain("openai");
			expect(text).toContain("[ Add new provider ]");
		} finally {
			if (prevHome === undefined) delete process.env.KEA_HOME;
			else process.env.KEA_HOME = prevHome;
			await removeTempDir(home);
		}
	});
});

describe("openModelPicker empty-state copy", () => {
	test("zero available models → points to /provider", async () => {
		const { openModelPicker } = await import("../src/tui/controllers/model-config.ts");
		const { ctx, statuses } = fakeCtx();
		(ctx.kernel as { models: unknown }).models = { getAvailable: async () => [] };
		openModelPicker(ctx);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(statuses.map((s) => s.text)).toContain(
			"No models available — run /provider to add credentials, or export *_API_KEY.",
		);
	});
});

const FAKE_MODEL = { provider: "mylab", id: "researcher-72b", name: "researcher-72b", contextWindow: 131072 };

function flowCtx(
	options: {
		messages?: Array<Record<string, unknown>>;
		getProvider?: (id: string) => { id: string; name: string } | undefined;
		available?: Array<{ provider: string; id: string; name: string; contextWindow: number }>;
		registered?: string[];
	} = {},
) {
	const statuses: Array<{ text: string; tone?: string }> = [];
	const errors: string[] = [];
	const mounted: unknown[] = [];
	const deleteProviderSpy = vi.fn();
	const models = {
		getProviders: () => [] as Array<{ id: string }>,
		getProvider: options.getProvider ?? ((_id: string) => undefined),
		getAuth: async (_id: string) => undefined,
		getAvailable: async () => options.available ?? [],
		deleteProvider: deleteProviderSpy,
	};
	const kernel = {
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		models,
		agent: { state: { isStreaming: false, messages: options.messages ?? [] } },
		reloadCustomModels: async () => options.registered ?? [],
	};
	const ctx = {
		kernel,
		styles: () => identityStyles(),
		mountDialog: (component: unknown) => mounted.push(component),
		restoreEditor: () => {},
		showStatus: (text: string, tone?: string) => statuses.push({ text, tone }),
		showError: (text: string) => errors.push(text),
		tui: { requestRender: () => {} },
	};
	return {
		ctx: ctx as never as TUICtx,
		kernel,
		models,
		statuses,
		errors,
		mounted,
		deleteProviderSpy,
	};
}

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

/** KEA_HOME + cwd double isolation: neither the credential ledger nor .kea/models.json touches the real home/project dirs. */
async function withIsolatedHome<T>(fn: (home: string, cwd: string) => Promise<T>): Promise<T> {
	const home = await makeTempDir("kea-home-");
	const cwd = await makeTempDir("kea-cwd-");
	const prevHome = process.env.KEA_HOME;
	const prevCwd = process.cwd();
	process.env.KEA_HOME = home;
	process.chdir(cwd);
	try {
		return await fn(home, cwd);
	} finally {
		process.chdir(prevCwd);
		if (prevHome === undefined) delete process.env.KEA_HOME;
		else process.env.KEA_HOME = prevHome;
		await removeTempDir(home);
		await removeTempDir(cwd);
	}
}

describe("provider id collision validation (rejects builtin/registered ids)", () => {
	test("builtin-derived id conflicts and pre-fills a non-conflicting suggestion", async () => {
		const { runAddProviderFlow } = await import("../src/tui/controllers/model-config.ts");
		const { ctx, mounted } = flowCtx({
			getProvider: (id) => (id === "openai" ? { id, name: "OpenAI" } : undefined),
		});
		runAddProviderFlow(ctx, { customDirect: true });
		const urlStep = mounted[0] as PromptStep;
		urlStep.handleInput("https://api.openai.com/v1");
		urlStep.handleInput("\r");
		const pidStep = mounted[1] as PromptStep;
		expect(pidStep).toBeInstanceOf(PromptStep);
		expect(pidStep.getValue()).toBe("openai-custom");
		pidStep.handleInput("\r");
		expect(mounted[2]).toBeInstanceOf(FilterablePicker);
	});

	test("busy refusal carries the actionable copy", async () => {
		const { runAddProviderFlow } = await import("../src/tui/controllers/model-config.ts");
		const { ctx, statuses } = flowCtx();
		(ctx.kernel.agent.state as { isStreaming: boolean }).isStreaming = true;
		runAddProviderFlow(ctx, { customDirect: true });
		expect(statuses.map((s) => s.text)).toContain("Cannot add providers while streaming — press Esc or Ctrl-C first.");
	});
});

describe("validateProviderId (pure function: schema → builtin → custom conflict)", () => {
	test("rejects schema-invalid, builtin, and already-taken ids", async () => {
		const { validateProviderId } = await import("../src/tui/controllers/model-config.ts");
		const builtin = new Set(["openai", "anthropic"]);
		expect(validateProviderId("OpenAI!", builtin, () => false)).toBe(
			"Only lowercase letters, digits, _-; must start with a letter or digit",
		);
		expect(validateProviderId("openai", builtin, () => false)).toBe(
			"openai is a builtin provider — use /provider → Known provider to add its key",
		);
		expect(validateProviderId("mylab", builtin, () => true)).toBe("A provider with this id already exists");
		expect(validateProviderId("mylab", builtin, () => false)).toBeUndefined();
	});
});

describe("custom add flow: key persists only on completion (orphaned-credential guard)", () => {
	async function driveToKeyStep(ctx: TUICtx, mounted: unknown[]): Promise<void> {
		const { runAddProviderFlow } = await import("../src/tui/controllers/model-config.ts");
		runAddProviderFlow(ctx, { customDirect: true });
		const urlStep = mounted[0] as PromptStep;
		urlStep.handleInput("https://api.mylab.ai/v1");
		urlStep.handleInput("\r");
		const apiPicker = mounted[1] as FilterablePicker;
		apiPicker.handleInput("\x1b[B");
		apiPicker.handleInput("\x1b[B");
		apiPicker.handleInput("\r");
		await tick();
	}

	test("cancel after the key step leaves auth.json and models.json untouched", async () => {
		await withIsolatedHome(async (home, cwd) => {
			const { ctx, mounted, statuses } = flowCtx();
			await driveToKeyStep(ctx, mounted);
			const keyStep = mounted[2] as PromptStep;
			expect(keyStep).toBeInstanceOf(PromptStep);
			keyStep.handleInput("sk-secret-123");
			keyStep.handleInput("\r");
			await tick();
			const modelStep = mounted[3] as PromptStep;
			expect(modelStep).toBeInstanceOf(PromptStep);
			modelStep.handleInput("\x1b");
			expect(statuses.map((s) => s.text)).toContain("Provider add cancelled");
			expect(await Bun.file(`${home}/.kea/auth.json`).exists()).toBe(false);
			expect(await Bun.file(`${cwd}/.kea/models.json`).exists()).toBe(false);
		});
	});

	test("completing the flow persists models.json AND auth.json, then auto-opens the model picker", async () => {
		await withIsolatedHome(async (home, cwd) => {
			const { ctx, mounted, statuses } = flowCtx({
				available: [FAKE_MODEL],
				registered: ["mylab"],
			});
			await driveToKeyStep(ctx, mounted);
			const keyStep = mounted[2] as PromptStep;
			keyStep.handleInput("sk-secret-123");
			keyStep.handleInput("\r");
			await tick();
			const modelStep = mounted[3] as PromptStep;
			modelStep.handleInput("researcher-72b");
			modelStep.handleInput("\r");
			const ctxStep = mounted[4] as PromptStep;
			ctxStep.handleInput("\r");
			await tick(30);

			const file = (await Bun.file(`${cwd}/.kea/models.json`).json()) as {
				providers: Array<{ id: string; models: Array<{ id: string }> }>;
			};
			expect(file.providers.map((p) => p.id)).toEqual(["mylab"]);
			const auth = (await Bun.file(`${home}/.kea/auth.json`).json()) as Record<string, { type: string; key: string }>;
			expect(auth.mylab).toEqual({ type: "api_key", key: "sk-secret-123" });
			expect(statuses.map((s) => s.text)).toContain(`${SUCCESS_MARK} Added mylab/researcher-72b`);
			// Kimi-style wrap-up: auto-open the model picker after success
			expect(mounted.some((c) => c instanceof FilterablePicker)).toBe(true);
		});
	});
});

describe("known-provider key save (one-step key save + auto-open picker)", () => {
	test("saving a key for a builtin provider opens the model picker", async () => {
		await withIsolatedHome(async (home) => {
			const { runAddProviderFlow } = await import("../src/tui/controllers/model-config.ts");
			const { ctx, mounted, statuses } = flowCtx({
				getProvider: (id) => (id === "anthropic" ? { id, name: "Anthropic" } : undefined),
				available: [FAKE_MODEL],
			});
			runAddProviderFlow(ctx);
			(mounted[0] as FilterablePicker).handleInput("\r");
			(mounted[1] as FilterablePicker).handleInput("\r");
			const keyStep = mounted[2] as PromptStep;
			expect(keyStep).toBeInstanceOf(PromptStep);
			keyStep.handleInput("sk-known-key");
			keyStep.handleInput("\r");
			await tick(30);

			const auth = (await Bun.file(`${home}/.kea/auth.json`).json()) as Record<string, { type: string; key: string }>;
			expect(auth.anthropic).toEqual({ type: "api_key", key: "sk-known-key" });
			expect(statuses.map((s) => s.text)).toContain(`${SUCCESS_MARK} Saved`);
			expect(mounted.some((c) => c instanceof FilterablePicker && c !== mounted[0] && c !== mounted[1])).toBe(true);
		});
	});
});

describe("deleteProvider builtin guard (poisoned entry must not unregister a builtin provider)", () => {
	test("deleting a builtin row mislabeled custom removes the orphan entry but keeps the provider registered", async () => {
		await withIsolatedHome(async (home, cwd) => {
			const { openProviderManager } = await import("../src/tui/controllers/model-config.ts");
			const { ProviderPanel } = await import("../src/tui/components/dialogs/provider-panel.ts");
			await Bun.write(
				`${cwd}/.kea/models.json`,
				JSON.stringify({
					providers: [
						{
							id: "openai",
							baseUrl: "https://evil.example/v1",
							models: [{ id: "gpt-x", contextWindow: 8192 }],
						},
					],
				}),
			);
			await Bun.write(`${home}/.kea/auth.json`, JSON.stringify({ openai: { type: "api_key", key: "sk-old" } }));

			const registered = new Set(["openai"]);
			const deleteProviderSpy = vi.fn((id: string) => registered.delete(id));
			const models = {
				getProviders: () => [{ id: "openai", getModels: () => [{ id: "gpt-5", contextWindow: 100000 }] }],
				getAuth: async (_id: string) => ({ auth: { apiKey: "x" }, source: "stored credential" }),
				deleteProvider: deleteProviderSpy,
			};
			const mounted: unknown[] = [];
			const ctx = {
				kernel: {
					model: { provider: "openai", id: "gpt-x" },
					models,
					agent: { state: { isStreaming: false } },
					reloadCustomModels: async () => [],
				},
				styles: () => identityStyles(),
				mountDialog: (component: unknown) => mounted.push(component),
				restoreEditor: () => {},
				showStatus: () => {},
				showError: () => {},
				tui: { requestRender: () => {} },
			};
			openProviderManager(ctx as never as TUICtx);
			await tick(30);
			const panel = mounted[0] as InstanceType<typeof ProviderPanel>;
			expect(panel).toBeInstanceOf(ProviderPanel);
			panel.handleInput("D");
			panel.handleInput("y");
			await tick(30);

			const file = (await Bun.file(`${cwd}/.kea/models.json`).json()) as { providers: unknown[] };
			expect(file.providers).toEqual([]);
			const auth = (await Bun.file(`${home}/.kea/auth.json`).json()) as Record<string, unknown>;
			expect(auth.openai).toBeUndefined();
			expect(deleteProviderSpy).not.toHaveBeenCalled();
			expect(registered.has("openai")).toBe(true);
		});
	});
});

describe("openModelPicker cache-invalidation notice (warn before selection, Kimi precedent)", () => {
	test("with assistant history the picker renders the warning line before selection", async () => {
		const { openModelPicker } = await import("../src/tui/controllers/model-config.ts");
		const { ctx, mounted } = flowCtx({
			messages: [{ role: "assistant", content: [] }],
			available: [{ provider: "openai", id: "gpt-5", name: "gpt-5", contextWindow: 100000 }],
		});
		openModelPicker(ctx);
		await tick(30);
		const picker = mounted.find((c) => c instanceof FilterablePicker) as FilterablePicker | undefined;
		expect(picker).toBeDefined();
		const text = (picker as FilterablePicker).render(120).join("\n");
		expect(text).toContain("Switching models invalidates the existing prompt cache.");
	});

	test("fresh session: no warning line in the picker", async () => {
		const { openModelPicker } = await import("../src/tui/controllers/model-config.ts");
		const { ctx, mounted } = flowCtx({
			available: [{ provider: "openai", id: "gpt-5", name: "gpt-5", contextWindow: 100000 }],
		});
		openModelPicker(ctx);
		await tick(30);
		const picker = mounted.find((c) => c instanceof FilterablePicker) as FilterablePicker | undefined;
		expect(picker).toBeDefined();
		expect((picker as FilterablePicker).render(120).join("\n")).not.toContain(
			"Switching models invalidates the existing prompt cache.",
		);
	});
});
