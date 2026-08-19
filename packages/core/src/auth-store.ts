import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { z } from "zod";
import { keaHome } from "./trust.ts";

// File credential store (pi CredentialStore implementation, keyed by provider id, `~/.kea/auth.json`).
// - directory 0700, file 0600; tmp is 0600 from creation (open with mode), atomic rename, cleanup on failure;
// - zod validation on read: malformed JSON / schema violations → empty ledger (fail-closed) + at most one warn;
//   a file that EXISTS but is invalid is poisoned: modify()/delete() refuse instead of rewriting from the empty
//   base (which would silently drop every other valid key); remove or fix the file manually to unblock writes;
// - never writes OAuth: modify() rejects non-api_key credentials;
// - in-process serialization: a module-level promise chain is shared by all instances (kernel/cli/doctor each
//   new one), so concurrent modify/delete run read-modify-write in order, never losing writes;
// - authStorePath() is sampled once per operation: a KEA_HOME change mid-operation never forks the ledger.
// Normal path is zero-output; the key itself never reaches logs.

const ApiKeyCredentialSchema = z.object({
	type: z.literal("api_key"),
	key: z.string().optional(),
	env: z.record(z.string(), z.string()).optional(),
});

// read-only validation: OAuth entries hand-placed in the file are not punished for overall malformation, but modify() never writes them
const OAuthCredentialSchema = z.object({
	type: z.literal("oauth"),
	refresh: z.string(),
	access: z.string(),
	expires: z.number(),
});

const CredentialSchema = z.discriminatedUnion("type", [ApiKeyCredentialSchema, OAuthCredentialSchema]);

const AuthFileSchema = z.record(z.string(), CredentialSchema);

export function authStorePath(): string {
	return join(keaHome(), ".kea", "auth.json");
}

/** Process-level serial chain for modify/delete: the next write only reads after the previous one is on disk, preventing lost writes (shared by all instances). */
let writeChain: Promise<unknown> = Promise.resolve();

export class FileCredentialStore implements CredentialStore {
	private warnedMalformed = false;

	async read(providerId: string): Promise<Credential | undefined> {
		const { store } = await this.readStore(authStorePath());
		return store[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const { store } = await this.readStore(authStorePath());
		return Object.entries(store).map(([pid, cred]) => ({ providerId: pid, type: cred.type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const op = writeChain.then(async () => {
			// sample KEA_HOME once at operation start: read and write use the same path, so a mid-operation env change does not fork
			const target = authStorePath();
			const { store, poisoned } = await this.readStore(target);
			if (poisoned) throw this.poisonedRefusal(target);
			const current = store[providerId];
			const next = await fn(current);
			if (next === undefined) return current;
			if (next.type !== "api_key") {
				throw new Error(
					`Kea stores API-key credentials only — refusing to store an OAuth credential for "${providerId}"`,
				);
			}
			store[providerId] = next;
			await this.writeStore(target, store);
			return next;
		});
		// a single failure must not break the chain: later modifies still run in order
		writeChain = op.catch(() => {});
		return op;
	}

	delete(providerId: string): Promise<void> {
		const op = writeChain.then(async () => {
			const target = authStorePath();
			const { store, poisoned } = await this.readStore(target);
			if (poisoned) throw this.poisonedRefusal(target);
			if (!(providerId in store)) return;
			delete store[providerId];
			await this.writeStore(target, store);
		});
		writeChain = op.catch(() => {});
		return op;
	}

	/** absent file → empty and writable; existing-but-invalid file → empty for reads (fail-closed) but poisoned for writes. */
	private async readStore(target: string): Promise<{ store: Record<string, Credential>; poisoned: boolean }> {
		const file = Bun.file(target);
		if (!(await file.exists())) return { store: {}, poisoned: false };
		let raw: unknown;
		try {
			raw = await file.json();
		} catch {
			this.warnMalformed(target, "invalid JSON");
			return { store: {}, poisoned: true };
		}
		const parsed = AuthFileSchema.safeParse(raw);
		if (!parsed.success) {
			this.warnMalformed(target, `schema violation (${z.prettifyError(parsed.error)})`);
			return { store: {}, poisoned: true };
		}
		return { store: parsed.data, poisoned: false };
	}

	private poisonedRefusal(target: string): Error {
		return new Error(
			`refusing to rewrite malformed credential ledger ${target}: a write from the empty fallback base would ` +
				`delete every valid key it holds — fix or remove the file manually, then retry`,
		);
	}

	private warnMalformed(target: string, detail: string): void {
		if (this.warnedMalformed) return;
		this.warnedMalformed = true;
		console.warn(`[auth-store] ignoring malformed ${target}: ${detail} (treating as empty)`);
	}

	private async writeStore(target: string, store: Record<string, Credential>): Promise<void> {
		// derive the directory from the target captured for this operation (same semantics as ensureKeaHomeDir: 0700, tighten best-effort)
		const dir = dirname(target);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmod(dir, 0o700).catch(() => {});
		const tmp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
		try {
			// open(…, 0o600): tmp is 0600 from creation — a Bun.write+chmod sequence would leave a key-exposure
			// window at umask permissions and a crash could leave a 0644 key file; the final chmod covers
			// unusual umasks that strip bits from the open mode
			const handle = await open(tmp, "w", 0o600);
			try {
				await handle.writeFile(JSON.stringify(store, null, 2));
				await handle.chmod(0o600);
			} finally {
				await handle.close();
			}
			await rename(tmp, target);
		} catch (err) {
			await rm(tmp, { force: true }).catch(() => {});
			throw err;
		}
	}
}
