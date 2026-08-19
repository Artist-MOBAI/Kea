import type { Credential } from "@earendil-works/pi-ai";
import { z } from "zod";
import { authStorePath, FileCredentialStore } from "./auth-store.ts";
import { loadBackendsConfigDetailed } from "./execution/backends-config.ts";
import { loadMcpConfigDetailed } from "./mcp.ts";
import { CustomModelsFileSchema, type CustomProvider, customModelsPath, dedupeCustomProviders } from "./models.ts";
import { sessionsRoot } from "./session.ts";
import { isFolderTrusted } from "./trust.ts";

export interface DoctorCheck {
	name: string;
	ok: boolean;
	detail: string;
	hint?: string;
}

export async function runDoctor(cwd: string): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	const trusted = await isFolderTrusted(cwd);

	// stored credentials (~/.kea/auth.json) and env vars are both usable: doctor must not report ✗ when a stored key exists.
	// pi semantics: only {type:"api_key"} with a non-empty key counts as a real stored override (an empty-key entry
	// falls back to env); a hand-written oauth entry blocks an apiKey-only provider (reported separately below)
	const storedCredentials = new Map<string, Credential>();
	try {
		const store = new FileCredentialStore();
		for (const info of await store.list()) {
			const cred = await store.read(info.providerId);
			if (cred) storedCredentials.set(info.providerId, cred);
		}
	} catch {
		// auth.json unreadable → treat as no stored credentials
	}
	const storedCoveredIds = [...storedCredentials]
		.filter(([, cred]) => cred.type === "api_key" && Boolean(cred.key))
		.map(([id]) => id);
	// pi-ai's google provider only resolves GEMINI_API_KEY (the envApiKeyAuth list), not GOOGLE_API_KEY
	const modelEnv = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MOONSHOT_API_KEY", "GEMINI_API_KEY"].filter(
		(k) => process.env[k],
	);
	const hasCredential = modelEnv.length > 0 || storedCoveredIds.length > 0;
	const credentialDetail = [
		modelEnv.length > 0 ? `found: ${modelEnv.join(", ")}` : "",
		storedCoveredIds.length > 0 ? `stored: ${storedCoveredIds.join(", ")}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	checks.push({
		name: "model credentials",
		ok: hasCredential,
		detail: hasCredential ? credentialDetail : "no provider API key in environment",
		hint: hasCredential ? undefined : "export ANTHROPIC_API_KEY=... (or kea.toml defaultModel + matching key)",
	});

	// report only each custom provider's credential source label, never the key; untrusted dirs get a trust note
	// (the runtime trust-gates models.json — these checks do not mean the kernel has loaded them)
	const trustNote = trusted ? "" : " (gated by workspace trust)";
	const modelsFile = Bun.file(customModelsPath(cwd));
	if (await modelsFile.exists()) {
		let providerConfigs: CustomProvider[] | undefined;
		try {
			const parsed = CustomModelsFileSchema.safeParse(await modelsFile.json());
			// dedupe from the same source as the runtime: the count reflects how many providers kernel would actually register
			if (parsed.success) providerConfigs = dedupeCustomProviders(parsed.data.providers);
			else {
				checks.push({
					name: "custom models config",
					ok: false,
					detail: `schema violation: ${z.prettifyError(parsed.error)}${trustNote}`,
					hint: "Fix .kea/models.json — providers need id/baseUrl/models, see CustomModelsFileSchema",
				});
			}
		} catch {
			checks.push({
				name: "custom models config",
				ok: false,
				detail: `not valid JSON${trustNote}`,
				hint: "Fix .kea/models.json — providers need id/baseUrl/models, see CustomModelsFileSchema",
			});
		}
		if (providerConfigs) {
			checks.push({
				name: "custom models config",
				ok: true,
				detail: `${providerConfigs.length} provider(s) in .kea/models.json${trustNote}`,
			});
			// same resolution order as the runtime: stored credential first, env var fallback
			for (const config of providerConfigs) {
				const stored = storedCredentials.get(config.id);
				// an oauth entry on an apiKey-only provider → pi resolves to undefined directly, no env fallback
				if (stored?.type === "oauth") {
					checks.push({
						name: `credential (${config.id})`,
						ok: false,
						detail: `stored oauth entry blocks this provider${trustNote}`,
						hint: `Remove the oauth entry for "${config.id}" from ${authStorePath()} — Kea stores API keys only`,
					});
					continue;
				}
				const source =
					stored?.type === "api_key" && stored.key
						? "stored key"
						: config.apiKeyEnv && process.env[config.apiKeyEnv]
							? `env ${config.apiKeyEnv}`
							: undefined;
				checks.push({
					name: `credential (${config.id})`,
					ok: source !== undefined,
					detail: `${source ?? "no stored key and no API key in environment"}${trustNote}`,
					hint: source
						? undefined
						: config.apiKeyEnv
							? `export ${config.apiKeyEnv}=… or store a key for "${config.id}"`
							: `Store a key for "${config.id}" (it has no apiKeyEnv fallback)`,
				});
			}
		}
	}

	checks.push({
		name: "workspace trust",
		ok: trusted,
		detail: trusted ? "trusted" : "not trusted yet",
		hint: trusted ? undefined : "Run interactive kea to confirm trust",
	});

	// Bun.spawn throws synchronously when the executable is missing ("Executable not found in $PATH"):
	// every spawn probe must be wrapped, or one missing binary rejects the whole doctor run
	try {
		const pyProbe = Bun.spawn(["python3", "--version"], { stdout: "pipe", stderr: "ignore" });
		const pyExit = await pyProbe.exited;
		const pyVersion = (await new Response(pyProbe.stdout).text()).trim();
		checks.push({
			name: "python3",
			ok: pyExit === 0,
			detail: pyExit === 0 ? pyVersion : "not found",
			hint: pyExit === 0 ? undefined : "Research toolchain (evaluator/RDKit/MLIP) requires python3",
		});
	} catch {
		checks.push({
			name: "python3",
			ok: false,
			detail: "not found",
			hint: "Research toolchain (evaluator/RDKit/MLIP) requires python3",
		});
	}

	// loadMcpConfig is fail-closed: doctor is trust-gated the same way as kernel, untrusted does not report project-level servers.
	// Detailed load surfaces parse/validation errors instead of a silent "none configured" (same pattern as backends.json).
	const mcpLoad = await loadMcpConfigDetailed(cwd, { includeProject: trusted });
	if (mcpLoad.errors.length > 0) {
		checks.push({
			name: "mcp config",
			ok: false,
			detail: mcpLoad.errors.join("; "),
			hint: 'Fix .kea/mcp.json — expected shape: { "mcpServers": { name: { command, args?, env? } | { url, headers?, transport? } } }',
		});
	} else {
		const mcpCount = Object.keys(mcpLoad.config.mcpServers ?? {}).length;
		checks.push({
			name: "mcp config",
			ok: true,
			detail: mcpCount === 0 ? "none configured" : `${mcpCount} server(s) in .kea/mcp.json`,
		});
	}

	// surface real parse/validation errors for a corrupted backends.json, not a silent "none configured"
	const backendsLoad = await loadBackendsConfigDetailed(cwd);
	if (backendsLoad.errors.length > 0) {
		checks.push({
			name: "remote backends",
			ok: false,
			detail: backendsLoad.errors.join("; "),
			hint: 'Fix .kea/backends.json — expected shape: { "backends": [{ "type": "ssh"|"slurm", "config": {...} }] }',
		});
	} else {
		checks.push({
			name: "remote backends",
			ok: true,
			detail:
				backendsLoad.backends.length === 0
					? "none configured"
					: `${backendsLoad.backends.length} backend(s) in .kea/backends.json`,
		});
	}

	checks.push({
		name: "Materials Project key",
		ok: Boolean(process.env.MP_API_KEY),
		detail: process.env.MP_API_KEY ? "MP_API_KEY set" : "absent — falls back to public OPTIMADE endpoints",
		hint: process.env.MP_API_KEY ? undefined : "Register free at materialsproject.org for an API key",
	});

	// sessions are individual .jsonl files under .kea/sessions (no index file): count real files
	let sessionCount = 0;
	try {
		for await (const _file of new Bun.Glob("**/*.jsonl").scan({ cwd: sessionsRoot(cwd), onlyFiles: true })) {
			sessionCount += 1;
		}
	} catch {
		// .kea/sessions does not exist yet
	}
	checks.push({
		name: "session store",
		ok: true,
		detail: sessionCount === 0 ? "no sessions yet" : `${sessionCount} session(s) in .kea/sessions`,
	});

	return checks;
}
