import { join } from "node:path";
import type {
	Api,
	CredentialStore,
	Model,
	Models,
	MutableModels,
	Provider,
	ProviderStreams,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import {
	stream as anthropicStream,
	streamSimple as anthropicStreamSimple,
} from "@earendil-works/pi-ai/api/anthropic-messages";
import {
	stream as openaiStream,
	streamSimple as openaiStreamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import {
	stream as openaiResponsesStream,
	streamSimple as openaiResponsesStreamSimple,
} from "@earendil-works/pi-ai/api/openai-responses";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { z } from "zod";
import { ModelResolutionError } from "./errors.ts";

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

/** Once a credential store is passed, built-in providers prefer stored keys with environment variables as fallback (pi auth/resolve order). */
export function createModelsCollection(credentials?: CredentialStore): Models {
	return builtinModels(credentials ? { credentials } : undefined);
}

export interface ResolvedModel {
	model: Model<Api>;
	providerId: string;
	modelId: string;
}

export function parseModelSpec(models: Models, spec?: string): ResolvedModel {
	const s = spec ?? process.env.KEA_MODEL ?? DEFAULT_MODEL;
	const idx = s.indexOf("/");
	if (idx <= 0 || idx === s.length - 1) {
		throw new ModelResolutionError(`Invalid model spec "${s}" — expected "provider/model-id" (e.g. ${DEFAULT_MODEL})`);
	}
	const providerId = s.slice(0, idx);
	const modelId = s.slice(idx + 1);
	const provider = models.getProvider(providerId);
	if (!provider) {
		throw new ModelResolutionError(
			`Unknown provider "${providerId}". Available: ${models
				.getProviders()
				.map((p) => p.id)
				.join(", ")}`,
		);
	}
	const model = models.getModel(providerId, modelId);
	if (!model) {
		const available = provider
			.getModels()
			.map((m) => m.id)
			.slice(0, 20)
			.join(", ");
		throw new ModelResolutionError(`Unknown model "${modelId}" for provider "${providerId}". Available: ${available}`);
	}
	return { model, providerId, modelId };
}

export function resolveModel(models: Models, spec?: string): Model<Api> {
	return parseModelSpec(models, spec).model;
}

export const CustomModelEntrySchema = z.object({
	id: z.string().min(1),
	name: z.string().optional(),
	contextWindow: z.number().int().positive().default(131072),
	maxTokens: z.number().int().positive().default(8192),
	reasoning: z.boolean().default(false),
});
export type CustomModelEntry = z.infer<typeof CustomModelEntrySchema>;

/** Wire APIs supported by custom providers (one-to-one with pi's stream implementation modules). */
export const CUSTOM_PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type CustomApi = (typeof CUSTOM_PROVIDER_APIS)[number];

export const CustomProviderSchema = z.object({
	id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "provider id: lowercase [a-z0-9_-]"),
	name: z.string().optional(),

	// restrict to http(s): a hand-written .kea/models.json bypasses the TUI wizard's validation, so file:// and similar schemes must be blocked.
	// not z.httpUrl() — its hostname pattern rejects localhost/IP, which would wrongly hit local inference endpoints (vLLM/ollama).
	// transform strips trailing slashes: a hand-written "…/v1/" would otherwise be probed as "…/v1//models"
	baseUrl: z.url({ protocol: /^https?$/i }).transform((url) => url.replace(/\/+$/, "")),

	api: z.enum(CUSTOM_PROVIDER_APIS).default("openai-completions"),
	// optional: when omitted the provider relies only on stored credentials (CredentialStore), with no env-var fallback
	apiKeyEnv: z.string().min(1).optional(),
	models: z.array(CustomModelEntrySchema).min(1),
});
export type CustomProvider = z.infer<typeof CustomProviderSchema>;

export const CustomModelsFileSchema = z.object({
	providers: z.array(CustomProviderSchema).default([]),
});

export function customModelsPath(cwd: string): string {
	return join(cwd, ".kea", "models.json");
}

export function dedupeCustomProviders(
	providers: CustomProvider[],
	onDuplicate?: (id: string) => void,
): CustomProvider[] {
	const seen = new Set<string>();
	const out: CustomProvider[] = [];
	for (const provider of providers) {
		if (seen.has(provider.id)) {
			onDuplicate?.(provider.id);
			continue;
		}
		seen.add(provider.id);
		out.push(provider);
	}
	return out;
}

export async function loadCustomProvidersConfig(cwd: string): Promise<CustomProvider[]> {
	const file = Bun.file(customModelsPath(cwd));
	if (!(await file.exists())) return [];
	let raw: unknown;
	try {
		raw = await file.json();
	} catch (err) {
		console.warn(`[models] ignoring .kea/models.json: invalid JSON (${reasonOf(err)})`);
		return [];
	}
	const parsed = CustomModelsFileSchema.safeParse(raw);
	if (!parsed.success) {
		console.warn(`[models] ignoring .kea/models.json: schema violation (${z.prettifyError(parsed.error)})`);
		return [];
	}
	return dedupeCustomProviders(parsed.data.providers, (id) =>
		console.warn(`[models] skipping duplicate provider "${id}" in .kea/models.json (first entry wins)`),
	);
}

function reasonOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Stream implementation table dispatched by config.api (the three api modules export the same names: stream/streamSimple). */
const CUSTOM_API_STREAMS: Record<CustomApi, ProviderStreams> = {
	"openai-completions": { stream: openaiStream, streamSimple: openaiStreamSimple },
	"openai-responses": { stream: openaiResponsesStream, streamSimple: openaiResponsesStreamSimple },
	"anthropic-messages": { stream: anthropicStream, streamSimple: anthropicStreamSimple },
};

export function buildCustomProvider(config: CustomProvider): Provider {
	const models: Model<CustomApi>[] = config.models.map((m) => ({
		id: m.id,
		name: m.name ?? m.id,
		api: config.api,
		provider: config.id,
		baseUrl: config.baseUrl,
		reasoning: m.reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
	}));
	return createProvider<CustomApi>({
		id: config.id,
		name: config.name ?? config.id,
		baseUrl: config.baseUrl,
		auth: {
			apiKey: {
				name: `${config.name ?? config.id} API key`,
				// pi reads the stored credential (CredentialStore, keyed by provider id) and passes it into resolve(),
				// where the provider consumes it (same posture as built-in providers); then apiKeyEnv env var is the fallback.
				resolve: async ({ ctx, credential }) => {
					if (credential?.key) {
						return { auth: { apiKey: credential.key }, source: "stored credential" };
					}
					if (!config.apiKeyEnv) return undefined;
					const key = await ctx.env(config.apiKeyEnv);
					if (!key) return undefined;
					return { auth: { apiKey: key }, source: config.apiKeyEnv };
				},
			},
		},
		models,
		api: CUSTOM_API_STREAMS[config.api],
	});
}

/** Records each Models collection's last successfully registered custom provider ids, so reloads can delete removed custom providers. */
const customRegistration = new WeakMap<Models, Set<string>>();

export async function registerCustomModels(cwd: string, models: Models): Promise<string[]> {
	const configs = await loadCustomProvidersConfig(cwd);
	// built-in provider ids are authoritative from pi's built-in list (the target collection may already hold previously registered custom providers; reload must be able to override)
	const builtinIds = new Set(
		builtinModels()
			.getProviders()
			.map((p) => p.id),
	);
	const mutable = models as MutableModels;
	const currentIds = new Set(configs.map((c) => c.id));
	// delete custom providers that were registered last time but removed from config: otherwise removing a provider from .kea/models.json leaves a stale in-memory provider until restart.
	// only touch ids this function registered before, never mistakenly deleting externally/dynamically registered providers like faux.
	const previous = customRegistration.get(models);
	if (previous) {
		for (const id of previous) {
			if (!currentIds.has(id)) mutable.deleteProvider(id);
		}
	}
	const registered: string[] = [];
	for (const config of configs) {
		// skip when colliding with a built-in id: otherwise a custom baseUrl would hijack a built-in provider's traffic
		if (builtinIds.has(config.id)) {
			console.warn(`[models] skipping custom provider "${config.id}": collides with a builtin provider`);
			continue;
		}
		mutable.setProvider(buildCustomProvider(config));
		registered.push(config.id);
	}
	customRegistration.set(models, new Set(registered));
	return registered;
}

export function listModels(models: Models): Array<{ spec: string; name: string; contextWindow: number }> {
	const out: Array<{ spec: string; name: string; contextWindow: number }> = [];
	for (const provider of models.getProviders()) {
		for (const model of provider.getModels()) {
			out.push({
				spec: `${model.provider}/${model.id}`,
				name: model.name === model.id ? model.id : `${model.name} (${model.id})`,
				contextWindow: model.contextWindow,
			});
		}
	}
	return out;
}

/** List only models with configured credentials and actually usable (pi-ai getAvailable: credential check + filterModels). */
export async function listAvailableModels(
	models: Models,
): Promise<Array<{ spec: string; name: string; contextWindow: number }>> {
	const available = await models.getAvailable();
	return available.map((model) => ({
		spec: `${model.provider}/${model.id}`,
		name: model.name === model.id ? model.id : `${model.name} (${model.id})`,
		contextWindow: model.contextWindow,
	}));
}
