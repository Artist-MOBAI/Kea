import type { MutableModels } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { matchesKey } from "@earendil-works/pi-tui";
import {
	authStorePath,
	type CustomApi,
	CustomModelsFileSchema,
	customModelsPath,
	FileCredentialStore,
	listAvailableModels,
	loadCustomProvidersConfig,
	probeOpenAiModels,
} from "@kea/core";
import { projectConfigPath, saveConfig } from "../../config.ts";
import { ProviderPanel, type ProviderRow } from "../components/dialogs/provider-panel.ts";
import { formatTokens } from "../constants/format.ts";
import { CURRENT_MARK, FAILURE_MARK, SUCCESS_MARK } from "../constants/symbols.ts";
import type { TUICtx } from "../ctx.ts";
import { FilterablePicker, type PickerItem, pickerTheme } from "../picker.ts";
import { PromptStep, type PromptStepOptions } from "../prompt-input.ts";
import { openEffortPicker, openPermissionPicker, showPicker } from "./overlays.ts";

export function normalizeBaseUrl(
	raw: string,
): { ok: true; url: string; warning?: string } | { ok: false; error: string } {
	let url = raw.trim();
	while (url.endsWith("/")) url = url.slice(0, -1);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the intent here is to reject whitespace/control characters
	if (/[\u0000-\u0020\u007f]/.test(url))
		return { ok: false, error: "Must not contain whitespace or control characters" };
	if (!/^https?:\/\/.+/.test(url)) return { ok: false, error: "Must start with http:// or https://" };
	if (url.endsWith("/chat/completions") || url.endsWith("/responses")) {
		return {
			ok: true,
			url,
			warning: "Usually the base URL stops before this path — remove it unless your gateway requires it.",
		};
	}
	return { ok: true, url };
}

export function validateContextWindow(v: string): string | undefined {
	if (v === "") return undefined;
	const n = Number(v);
	return /^\d+$/.test(v) && Number.isInteger(n) && n > 0 ? undefined : "Must be a positive integer";
}

export function deriveProviderId(baseUrl: string): string {
	try {
		const host = new URL(baseUrl).hostname;
		// IPv6 (with `[`/`:`) and an empty host cannot form a valid id.
		if (host === "" || host.includes(":") || host.includes("[")) return "custom";
		const labels = host.split(".");
		let core = labels[0] ?? "custom";
		if (labels.length >= 3 && ["api", "gateway", "llm", "endpoint", "ai"].includes(core)) {
			core = labels[1] ?? "custom";
		}
		const id = core.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
		// After stripping punctuation it must match the provider id schema, and a pure digit id (an IP literal) is ambiguous → fall back to custom.
		return /^[a-z0-9][a-z0-9_-]*$/.test(id) && !/^\d+$/.test(id) ? id : "custom";
	} catch {
		return "custom";
	}
}

export function validateProviderId(
	id: string,
	builtinIds: ReadonlySet<string>,
	isTaken: (id: string) => boolean,
): string | undefined {
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
		return "Only lowercase letters, digits, _-; must start with a letter or digit";
	}
	if (builtinIds.has(id)) return `${id} is a builtin provider — use /provider → Known provider to add its key`;
	if (isTaken(id)) return "A provider with this id already exists";
	return undefined;
}

export interface CustomProviderEntry {
	id: string;
	baseUrl: string;
	api?: CustomApi;
	apiKeyEnv?: string;
	models: Array<{ id: string; contextWindow: number }>;
}

export function mergeCustomProvider(
	providers: readonly CustomProviderEntry[],
	entry: CustomProviderEntry,
): CustomProviderEntry[] {
	const result: CustomProviderEntry[] = [...providers];
	const idx = result.findIndex((p) => p.id === entry.id);
	if (idx < 0) {
		result.push(entry);
		return result;
	}
	const existing = result[idx] as CustomProviderEntry;
	const models = [...existing.models];
	for (const m of entry.models) {
		const mi = models.findIndex((x) => x.id === m.id);
		if (mi >= 0) models[mi] = m;
		else models.push(m);
	}
	result[idx] = {
		...existing,
		baseUrl: entry.baseUrl,
		api: entry.api ?? existing.api,
		apiKeyEnv: entry.apiKeyEnv ?? existing.apiKeyEnv,
		models,
	};
	return result;
}

async function readCustomProviders(cwd: string): Promise<CustomProviderEntry[]> {
	const file = Bun.file(customModelsPath(cwd));
	if (!(await file.exists())) return [];
	try {
		const parsed = CustomModelsFileSchema.safeParse(await file.json());
		if (parsed.success) return [...parsed.data.providers];
	} catch {
		// Fall back to an empty list: the writer is responsible for rebuilding a valid file.
	}
	return [];
}

export async function writeCustomProviderEntry(cwd: string, entry: CustomProviderEntry): Promise<void> {
	const providers = mergeCustomProvider(await readCustomProviders(cwd), entry);
	await Bun.write(customModelsPath(cwd), JSON.stringify({ providers }, null, 2));
}

export async function removeCustomProviderEntry(cwd: string, providerId: string): Promise<void> {
	const providers = await readCustomProviders(cwd);
	const remaining = providers.filter((p) => p.id !== providerId);
	if (remaining.length === providers.length) return;
	await Bun.write(customModelsPath(cwd), JSON.stringify({ providers: remaining }, null, 2));
}

export function openModelPicker(ctx: TUICtx): void {
	void (async () => {
		const currentSpec = `${ctx.kernel.model.provider}/${ctx.kernel.model.id}`;
		const available = await listAvailableModels(ctx.kernel.models);
		if (available.length === 0) {
			ctx.showStatus("No models available — run /provider to add credentials, or export *_API_KEY.", "warning");
			return;
		}
		const items = buildModelPickerItems(available, currentSpec, ctx.kernel.model.provider);
		const styles = ctx.styles();
		const cacheNotice = hasAssistantHistory(ctx)
			? styles.warning("Switching models invalidates the existing prompt cache.")
			: undefined;
		const picker = new FilterablePicker(
			items,
			pickerTheme(styles),
			{
				onPick: (spec) => {
					if (spec.startsWith("__group__")) return;
					ctx.restoreEditor();
					applyModelSelection(ctx, spec, currentSpec, false);
				},
				onCancel: () => ctx.restoreEditor(),
			},
			(filter) =>
				`${styles.bold(" Select model ")}${styles.faint(
					`· type to filter${filter !== "" ? `: "${filter}"` : ""} · Enter select · Alt+S session-only · Esc cancel`,
				)}`,
			12,
			styles.primary,
			(data) => {
				if (!matchesKey(data, "alt+s")) return false;
				const selected = picker.getSelectedItem();
				if (selected && !selected.value.startsWith("__group__")) {
					ctx.restoreEditor();
					applyModelSelection(ctx, selected.value, currentSpec, true);
				}
				return true;
			},
			cacheNotice,
		);
		ctx.mountDialog(picker);
	})();
}

function buildModelPickerItems(
	available: Array<{ spec: string; name: string; contextWindow: number }>,
	currentSpec: string,
	currentProvider: string,
): PickerItem[] {
	const grouped = new Map<string, Array<{ spec: string; name: string; contextWindow: number }>>();
	for (const m of available) {
		const providerId = m.spec.split("/")[0] ?? "";
		const list = grouped.get(providerId) ?? [];
		list.push(m);
		grouped.set(providerId, list);
	}
	const items: PickerItem[] = [];
	const currentModel = available.find((m) => m.spec === currentSpec);
	if (currentModel) {
		items.push({
			value: currentModel.spec,
			label: currentModel.spec,
			description: `${CURRENT_MARK} · ${currentModel.name} · ctx ${formatTokens(currentModel.contextWindow)}`,
		});
	}
	for (const [providerId, models] of grouped) {
		const others =
			providerId === currentProvider && currentModel ? models.filter((m) => m.spec !== currentSpec) : models;
		if (others.length === 0) continue;
		items.push({ value: `__group__${providerId}`, label: `── ${providerId} ──`, description: "" });
		for (const m of others) {
			items.push({
				value: m.spec,
				label: m.spec,
				description: `${m.name} · ctx ${formatTokens(m.contextWindow)}`,
			});
		}
	}
	return items;
}

function hasAssistantHistory(ctx: TUICtx): boolean {
	return ctx.kernel.agent.state.messages.some((m) => "role" in m && m.role === "assistant");
}

export function applyModelSelection(ctx: TUICtx, spec: string, currentSpec: string, sessionOnly: boolean): void {
	if (ctx.kernel.agent.state.isStreaming) {
		ctx.showStatus("Cannot switch models while streaming — press Esc or Ctrl-C first.", "warning");
		return;
	}
	if (spec === currentSpec) {
		ctx.showStatus(`Already the current model: ${spec}`);
		return;
	}
	try {
		const model = ctx.kernel.setModel(spec);
		if (sessionOnly) {
			ctx.showStatus(`Switched to ${model.provider}/${model.id} for this session only.`, "success");
		} else {
			void saveConfig(projectConfigPath(process.cwd()), { defaultModel: spec });
			ctx.showStatus(`Switched default model: ${model.provider}/${model.id}`, "success");
		}
		if (hasAssistantHistory(ctx)) ctx.showStatus("Switching models invalidates the prompt cache.", "warning");
		ctx.refreshFooter();
	} catch (err) {
		ctx.showError(err instanceof Error ? err.message : String(err));
	}
}

function sourceLabel(source: string | undefined, hasStored: boolean): string {
	if (source === "stored credential") return "stored key";
	if (source !== undefined && source !== "") return source;
	return hasStored ? "stored key" : "";
}

async function collectProviderRows(ctx: TUICtx): Promise<ProviderRow[]> {
	const store = new FileCredentialStore();
	const customConfigs = await loadCustomProvidersConfig(process.cwd());
	const customById = new Map(customConfigs.map((c) => [c.id, c]));
	const currentProvider = ctx.kernel.model.provider;
	const rows: ProviderRow[] = [];
	for (const provider of ctx.kernel.models.getProviders()) {
		let source: string | undefined;
		try {
			source = (await ctx.kernel.models.getAuth(provider.id))?.source;
		} catch {
			source = undefined;
		}
		let hasStored = false;
		try {
			hasStored = (await store.read(provider.id)) !== undefined;
		} catch {
			hasStored = false;
		}
		if (source === undefined && !hasStored) continue;
		const custom = customById.get(provider.id);
		const modelList = provider.getModels().map((m) => ({ id: m.id, contextWindow: m.contextWindow }));
		rows.push({
			id: provider.id,
			source: sourceLabel(source, hasStored),
			baseUrl: custom?.baseUrl,
			kind: custom !== undefined ? "custom" : "builtin",
			isCurrent: provider.id === currentProvider,
			deletable: hasStored || custom !== undefined,
			modelCount: modelList.length,
			models: modelList,
			api: custom?.api ?? provider.getModels()[0]?.api,
			connectionStatus: undefined,
		});
	}
	return rows;
}

export function openProviderManager(ctx: TUICtx): void {
	if (ctx.kernel.agent.state.isStreaming) {
		ctx.showStatus("Cannot manage providers while streaming — press Esc or Ctrl-C first.", "warning");
		return;
	}
	void (async () => {
		const rows = await collectProviderRows(ctx);
		const panel = new ProviderPanel(rows, ctx.styles(), {
			onAdd: () => {
				ctx.restoreEditor();
				new AddProviderFlow(ctx).start();
			},
			onDelete: (row) => {
				void deleteProvider(ctx, panel, row);
			},
			onClose: () => ctx.restoreEditor(),
			onTestConnection: (row) => {
				void testProviderConnection(ctx, panel, row);
			},
			onEditBaseUrl: (row) => {
				ctx.restoreEditor();
				editProviderBaseUrl(ctx, row);
			},
		});
		ctx.mountDialog(panel);
	})();
}

async function deleteProvider(ctx: TUICtx, panel: ProviderPanel, row: ProviderRow): Promise<void> {
	try {
		if (row.kind === "custom") {
			await removeCustomProviderEntry(process.cwd(), row.id);
			if (!BUILTIN_PROVIDER_IDS.has(row.id)) {
				(ctx.kernel.models as MutableModels).deleteProvider(row.id);
			}
			await ctx.kernel.reloadCustomModels();
		}
		const store = new FileCredentialStore();
		if ((await store.read(row.id)) !== undefined) await store.delete(row.id);
	} catch (err) {
		ctx.showError(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	ctx.showStatus(`${SUCCESS_MARK} Removed ${row.id}`, "success");
	panel.setRows(await collectProviderRows(ctx));
	ctx.tui.requestRender();
}

async function testProviderConnection(ctx: TUICtx, panel: ProviderPanel, row: ProviderRow): Promise<void> {
	// Only OpenAI-compatible protocols expose a standard /models list endpoint; probing anthropic-messages/gemini and similar would falsely report 401/404.
	if (row.api !== "openai-completions" && row.api !== "openai-responses") {
		ctx.showStatus(`${row.id}: no OpenAI-compatible model-list endpoint to probe`, "warning");
		return;
	}
	const store = new FileCredentialStore();
	const customConfigs = await loadCustomProvidersConfig(process.cwd());
	const custom = customConfigs.find((c) => c.id === row.id);
	const baseUrl = custom?.baseUrl ?? ctx.kernel.models.getProvider(row.id)?.getModels()[0]?.baseUrl;
	let key: string | undefined;
	try {
		const credential = await store.read(row.id);
		key = credential?.type === "api_key" ? credential.key : undefined;
	} catch {
		key = undefined;
	}
	if (!baseUrl) {
		ctx.showStatus(`${row.id}: no base URL to probe`, "warning");
		return;
	}
	if (!key) {
		ctx.showStatus(`${row.id}: no stored API key to probe with`, "warning");
		return;
	}
	ctx.showStatus(`Probing ${row.id} (${baseUrl}/models) …`);
	const result = await probeOpenAiModels(baseUrl, key);
	if (result.ok) {
		ctx.showStatus(`${SUCCESS_MARK} ${row.id}: connected · ${result.models.length} models`, "success");
		panel.setProbeResult(row.id, "verified");
	} else {
		const hint =
			result.status === 401 ? "Key rejected" : result.status === 404 ? "Not found — check the base URL" : result.reason;
		ctx.showStatus(`${FAILURE_MARK} ${row.id}: ${hint}`, "warning");
		panel.setProbeResult(row.id, "failed");
	}
	ctx.tui.requestRender();
}

function editProviderBaseUrl(ctx: TUICtx, row: ProviderRow): void {
	flowPrompt(
		ctx,
		{
			question: `New base URL for ${row.id}`,
			placeholder: row.baseUrl ?? "https://api.example.com/v1",
			initial: row.baseUrl,
			validate: (v) => {
				const n = normalizeBaseUrl(v);
				return n.ok ? undefined : n.error;
			},
		},
		async (raw) => {
			const n = normalizeBaseUrl(raw);
			if (!n.ok) return;
			try {
				const providers = await readCustomProviders(process.cwd());
				const updated = mergeCustomProvider(providers, { id: row.id, baseUrl: n.url, models: [] });
				await Bun.write(customModelsPath(process.cwd()), JSON.stringify({ providers: updated }, null, 2));
				await ctx.kernel.reloadCustomModels();
				ctx.showStatus(`${SUCCESS_MARK} Updated ${row.id} base URL`, "success");
				openProviderManager(ctx);
			} catch (err) {
				ctx.showError(`Failed to update: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	);
}

const BUILTIN_PROVIDER_IDS = new Set<string>(getBuiltinProviders());

const KNOWN_PROVIDER_IDS = [
	"anthropic",
	"openai",
	"moonshotai",
	"google",
	"deepseek",
	"openrouter",
	"xai",
	"groq",
	"zai",
	"kimi-coding",
] as const;

const KNOWN_PROVIDER_ENV: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	moonshotai: "MOONSHOT_API_KEY",
	google: "GEMINI_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	xai: "XAI_API_KEY",
	groq: "GROQ_API_KEY",
	zai: "ZAI_API_KEY",
	"kimi-coding": "KIMI_API_KEY",
};

interface FlowDraft {
	pid?: string;
	baseUrl?: string;
	api?: CustomApi;
	mode?: "stored" | "env";
	apiKey?: string;
	apiKeyEnv?: string;
}

/** In-flow picker: Esc cancellation is reported as "cancelled" (distinct from showPicker's silent cancel). */
function flowPicker(ctx: TUICtx, items: PickerItem[], headerText: string, onPick: (value: string) => void): void {
	const styles = ctx.styles();
	const picker = new FilterablePicker(
		items,
		pickerTheme(styles),
		{
			onPick: (value) => {
				ctx.restoreEditor();
				onPick(value);
			},
			onCancel: () => {
				ctx.restoreEditor();
				ctx.showStatus("Provider add cancelled");
			},
		},
		(filter) =>
			`${styles.bold(` ${headerText} `)}${styles.faint(
				`· type to filter${filter !== "" ? `: "${filter}"` : ""} · ↑↓ navigate · Enter select · Esc cancel`,
			)}`,
		12,
		styles.primary,
	);
	ctx.mountDialog(picker);
}

function flowPrompt(ctx: TUICtx, opts: PromptStepOptions, onDone: (value: string) => void): void {
	const step = new PromptStep(
		opts,
		{
			onSubmit: (value) => {
				ctx.restoreEditor();
				onDone(value);
			},
			onCancel: () => {
				ctx.restoreEditor();
				ctx.showStatus("Provider add cancelled");
			},
		},
		ctx.styles().dim,
	);
	ctx.mountDialog(step);
}

const nonEmpty = (v: string): string | undefined => (v !== "" ? undefined : "Cannot be empty");

// Single state machine: the draft keeps all intermediate state in one place — retrying after a URL
// change never drops an already-entered key.
class AddProviderFlow {
	private readonly draft: FlowDraft = {};

	constructor(private readonly ctx: TUICtx) {}

	start(customDirect = false): void {
		if (this.ctx.kernel.agent.state.isStreaming) {
			this.ctx.showStatus("Cannot add providers while streaming — press Esc or Ctrl-C first.", "warning");
			return;
		}
		if (customDirect) this.customUrl();
		else this.choose();
	}

	private choose(): void {
		flowPicker(
			this.ctx,
			[
				{ value: "known", label: "Known provider (enter API key)", description: "Anthropic, OpenAI, Moonshot, …" },
				{ value: "custom", label: "Custom endpoint (OpenAI-compatible and others)" },
			],
			"Add provider",
			(choice) => (choice === "known" ? this.knownPick() : this.customUrl()),
		);
	}

	private knownPick(): void {
		const items: PickerItem[] = [];
		for (const id of KNOWN_PROVIDER_IDS) {
			const provider = this.ctx.kernel.models.getProvider(id);
			if (!provider) continue;
			items.push({ value: id, label: provider.name, description: provider.name === id ? undefined : id });
		}
		flowPicker(this.ctx, items, "Add provider — known providers", (pid) => this.knownKey(pid));
	}

	private knownKey(pid: string): void {
		const envVar = KNOWN_PROVIDER_ENV[pid];
		const storedHint = `Your key is stored in ${authStorePath()} (0600).`;
		const hint =
			envVar !== undefined && process.env[envVar]
				? `Detected ${envVar} — the stored key takes precedence.\n${storedHint}`
				: storedHint;
		flowPrompt(
			this.ctx,
			{ question: `Enter API key for ${pid}`, masked: true, hint, validate: nonEmpty },
			(key) => void this.finishKnown(pid, key),
		);
	}

	private async finishKnown(pid: string, key: string): Promise<void> {
		try {
			await new FileCredentialStore().modify(pid, async () => ({ type: "api_key", key }));
			this.ctx.showStatus(`${SUCCESS_MARK} Saved`, "success");
			openModelPicker(this.ctx);
		} catch (err) {
			this.ctx.showError(`Failed to store key: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private customUrl(): void {
		flowPrompt(
			this.ctx,
			{
				question: "Base URL (OpenAI-compatible root, e.g. https://api.mylab.ai/v1)",
				placeholder: "https://api.mylab.ai/v1",
				initial: this.draft.baseUrl,
				validate: (v) => {
					const n = normalizeBaseUrl(v);
					return n.ok ? undefined : n.error;
				},
			},
			(raw) => {
				const n = normalizeBaseUrl(raw);
				if (!n.ok) return;
				if (n.warning !== undefined) this.ctx.showStatus(n.warning, "warning");
				this.draft.baseUrl = n.url;
				const derived = deriveProviderId(n.url);
				// "custom" is the sentinel for "no meaningful id could be derived" (IP literals, etc.) → ask manually instead of silently using a poor id.
				if (derived === "custom" || this.ctx.kernel.models.getProvider(derived) !== undefined) {
					this.customPid(derived);
				} else {
					this.draft.pid = derived;
					this.customProtocol();
				}
			},
		);
	}

	private customPid(suggested: string): void {
		const isFallback = suggested === "custom";
		const isBuiltin = !isFallback && BUILTIN_PROVIDER_IDS.has(suggested);
		const fallback = isFallback ? "mylab" : `${suggested}-custom`;
		const hint = isFallback
			? "Couldn't derive a provider id from the hostname — enter one (e.g. mylab)."
			: isBuiltin
				? `${suggested} is a builtin provider — add its key via /provider → Known provider, or use a different id.`
				: `${suggested} is already taken — use a different id.`;
		flowPrompt(
			this.ctx,
			{
				question: "Provider id (lowercase letters/digits, e.g. mylab)",
				placeholder: fallback,
				initial: fallback,
				hint,
				validate: (v) =>
					validateProviderId(v, BUILTIN_PROVIDER_IDS, (id) => this.ctx.kernel.models.getProvider(id) !== undefined),
			},
			(pid) => {
				this.draft.pid = pid;
				this.customProtocol();
			},
		);
	}

	private customProtocol(): void {
		flowPicker(
			this.ctx,
			[
				{
					value: "openai-completions",
					label: "Chat Completions",
					description: `${CURRENT_MARK} · default — POST /chat/completions`,
				},
				{ value: "openai-responses", label: "Responses", description: "OpenAI Responses API" },
				{ value: "anthropic-messages", label: "Anthropic Messages", description: "POST /v1/messages" },
			],
			`API protocol for ${this.draft.pid}`,
			(api) => {
				this.draft.api = api as CustomApi;
				this.customKey();
			},
		);
	}

	private customKey(): void {
		flowPrompt(
			this.ctx,
			{
				question: `Enter API key for ${this.draft.pid}`,
				masked: true,
				hint: `Stored in ${authStorePath()} (0600). Leave empty to read from an env var instead.`,
				initial: this.draft.apiKey,
			},
			(key) => {
				if (key === "") {
					this.customEnv();
					return;
				}
				this.draft.mode = "stored";
				this.draft.apiKey = key;
				void this.probe();
			},
		);
	}

	private customEnv(): void {
		flowPrompt(
			this.ctx,
			{
				question: "Env var name that holds the API key (the key itself is never stored)",
				placeholder: "MYLAB_API_KEY",
				initial: this.draft.apiKeyEnv,
				validate: nonEmpty,
			},
			(name) => {
				this.draft.mode = "env";
				this.draft.apiKeyEnv = name;
				void this.probe();
			},
		);
	}

	private async probe(): Promise<void> {
		if (this.draft.api === "anthropic-messages") {
			this.ctx.showStatus("Anthropic Messages has no model-list endpoint — enter the model id manually.");
			this.customModel([]);
			return;
		}
		const key = this.draft.mode === "stored" ? this.draft.apiKey : process.env[this.draft.apiKeyEnv ?? ""];
		if (key === undefined || key === "") {
			const detail = this.draft.mode === "env" ? `${this.draft.apiKeyEnv ?? "env var"} is not set` : "no key entered";
			this.ctx.showStatus(`${FAILURE_MARK} Cannot verify right now: ${detail}`, "warning");
			this.probeFailure();
			return;
		}
		this.ctx.showStatus(`Probing ${this.draft.baseUrl}/models …`);
		const result = await probeOpenAiModels(this.draft.baseUrl ?? "", key);
		if (result.ok) {
			this.ctx.showStatus(`${SUCCESS_MARK} Connected · ${result.models.length} models`, "success");
			this.customModel(result.models);
			return;
		}
		const hint =
			result.status === 401
				? "Key rejected — check it and retry"
				: result.status === 404
					? "Not found — if the URL has no /v1 segment, try adding it"
					: result.reason;
		this.ctx.showStatus(`${FAILURE_MARK} ${hint}`, "warning");
		this.probeFailure();
	}

	private probeFailure(): void {
		const items: PickerItem[] = [];
		if (this.draft.mode === "stored") items.push({ value: "retry-key", label: "Retry with a different key" });
		else if (this.draft.mode === "env") items.push({ value: "retry-env", label: "Retry env var name" });
		items.push({ value: "retry-url", label: "Change base URL", description: this.draft.baseUrl });
		items.push({ value: "skip", label: "Continue without verification" });
		flowPicker(this.ctx, items, "Verification failed", (choice) => {
			if (choice === "retry-key") {
				// "Use a different key": clear the old value so customKey's initial backfill does not reuse it.
				this.draft.apiKey = undefined;
				this.customKey();
			} else if (choice === "retry-env") {
				this.customEnv();
			} else if (choice === "retry-url") {
				this.customUrl();
			} else {
				this.customModel([]);
			}
		});
	}

	private customModel(discovered: string[]): void {
		if (discovered.length > 0) {
			const items: PickerItem[] = discovered.map((id) => ({ value: id, label: id }));
			items.push({ value: "__custom__", label: "Other (type a model id)" });
			flowPicker(this.ctx, items, `Model id (${this.draft.pid})`, (choice) => {
				if (choice === "__custom__") this.customModelText();
				else this.customContext(choice);
			});
			return;
		}
		this.customModelText();
	}

	private customModelText(): void {
		flowPrompt(this.ctx, { question: "Model id", placeholder: "researcher-72b", validate: nonEmpty }, (id) =>
			this.customContext(id),
		);
	}

	private customContext(modelId: string): void {
		flowPrompt(
			this.ctx,
			{
				question: "Context window tokens (Enter for default 131072)",
				placeholder: "131072",
				validate: validateContextWindow,
			},
			(raw) => void this.finishCustom(modelId, raw),
		);
	}

	private async finishCustom(modelId: string, ctxWindowRaw: string): Promise<void> {
		const contextWindow = ctxWindowRaw === "" ? 131072 : Number(ctxWindowRaw);
		const entry: CustomProviderEntry = {
			id: this.draft.pid ?? "",
			baseUrl: this.draft.baseUrl ?? "",
			api: this.draft.api,
			...(this.draft.mode === "env" && this.draft.apiKeyEnv !== undefined ? { apiKeyEnv: this.draft.apiKeyEnv } : {}),
			models: [{ id: modelId, contextWindow }],
		};
		try {
			await writeCustomProviderEntry(process.cwd(), entry);
		} catch (err) {
			this.ctx.showError(`Write failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (this.draft.mode === "stored" && this.draft.apiKey !== undefined) {
			try {
				await new FileCredentialStore().modify(this.draft.pid ?? "", async () => ({
					type: "api_key",
					key: this.draft.apiKey ?? "",
				}));
			} catch (err) {
				this.ctx.showError(
					`Provider saved, but storing the key failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				return;
			}
		}
		const registered = await this.ctx.kernel.reloadCustomModels();
		if (!registered.includes(this.draft.pid ?? "")) {
			this.ctx.showError("Registration failed after writing config; check .kea/models.json");
			return;
		}
		this.ctx.showStatus(`${SUCCESS_MARK} Added ${this.draft.pid}/${modelId}`, "success");
		openModelPicker(this.ctx);
	}
}

export function runAddProviderFlow(ctx: TUICtx, options: { customDirect?: boolean } = {}): void {
	new AddProviderFlow(ctx).start(options.customDirect === true);
}

export function openSettingsPanel(ctx: TUICtx): void {
	const items: PickerItem[] = [
		{
			value: "model",
			label: "Model",
			description: `${CURRENT_MARK} ${ctx.kernel.model.provider}/${ctx.kernel.model.id}`,
		},
		{ value: "providers", label: "Providers & credentials", description: "Add/remove API keys and custom endpoints" },
		{ value: "permission", label: "Permission mode", description: `${CURRENT_MARK} ${ctx.kernel.permissionMode}` },
		{
			value: "effort",
			label: "Thinking effort",
			description: `${CURRENT_MARK} ${ctx.kernel.agent.state.thinkingLevel ?? "medium"}`,
		},
	];
	showPicker(ctx, items, "Settings", (value) => {
		if (value === "model") openModelPicker(ctx);
		else if (value === "providers") openProviderManager(ctx);
		else if (value === "permission") openPermissionPicker(ctx);
		else if (value === "effort") openEffortPicker(ctx);
	});
}
