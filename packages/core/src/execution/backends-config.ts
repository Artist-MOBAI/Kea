import { join } from "node:path";
import { z } from "zod";
import { SlurmConfigSchema } from "./slurm.ts";
import { SshConfigSchema } from "./ssh.ts";

const SshEntrySchema = z.object({ type: z.literal("ssh"), name: z.string().optional(), config: SshConfigSchema });
const SlurmEntrySchema = z.object({ type: z.literal("slurm"), name: z.string().optional(), config: SlurmConfigSchema });
const EntrySchema = z.union([SshEntrySchema, SlurmEntrySchema]);
const BackendsFileSchema = z.object({ backends: z.array(EntrySchema).default([]) });

export type BackendEntry = z.infer<typeof EntrySchema>;

export function backendsConfigPath(cwd: string): string {
	return join(cwd, ".kea", "backends.json");
}

export interface BackendsConfigLoad {
	backends: BackendEntry[];
	/** non-empty = backends.json exists but read/parse/validation failed (backends already emptied fail-closed); the caller should report the error to the user */
	errors: string[];
}

/**
 * Load with diagnostics: JSON syntax errors and schema validation errors both surface readably
 * (fail-closed semantics: a bad file = no backends).
 */
export async function loadBackendsConfigDetailed(cwd: string): Promise<BackendsConfigLoad> {
	const file = Bun.file(backendsConfigPath(cwd));
	if (!(await file.exists())) return { backends: [], errors: [] };
	let raw: unknown;
	try {
		raw = await file.json();
	} catch (err) {
		return {
			backends: [],
			errors: [`backends.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
		};
	}
	const parsed = BackendsFileSchema.safeParse(raw);
	if (!parsed.success) {
		return { backends: [], errors: [`backends.json failed validation: ${z.prettifyError(parsed.error)}`] };
	}
	return { backends: parsed.data.backends, errors: [] };
}

/** Compat for old callers (kernel and other best-effort sites): errors are silently an empty list; use loadBackendsConfigDetailed when you need diagnostics. */
export async function loadBackendsConfig(cwd: string): Promise<BackendEntry[]> {
	return (await loadBackendsConfigDetailed(cwd)).backends;
}
