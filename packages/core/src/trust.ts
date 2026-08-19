import { realpathSync } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { z } from "zod";

// Workspace trust: trust marks live in home (`~/.kea/trusted-folders.json`), never in the workspace — a
// checkout cannot pre-trust itself. Presence of the record means trusted; read failure/corruption is treated
// as untrusted (fail-closed); write failure silently stays untrusted (ask again next time).

const TrustFileSchema = z.object({
	folders: z.record(z.string(), z.object({ root: z.string(), trustedAt: z.string() })).optional(),
});

type TrustFile = z.infer<typeof TrustFileSchema>;

const McpConfigFileSchema = z.object({
	mcpServers: z.record(z.string(), z.unknown()).default({}),
});

export function keaHome(): string {
	return process.env.KEA_HOME ?? homedir();
}

export function trustStorePath(): string {
	return join(keaHome(), ".kea", "trusted-folders.json");
}

/** ~/.kea directory (0700): mkdir's mode only applies on creation; tighten best-effort if it already exists — this directory holds credential files. */
export async function ensureKeaHomeDir(): Promise<string> {
	const dir = join(keaHome(), ".kea");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700).catch(() => {});
	return dir;
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

async function readStore(): Promise<TrustFile> {
	try {
		const parsed = TrustFileSchema.safeParse(await Bun.file(trustStorePath()).json());
		// treat corrupted structure as an empty ledger (fail-closed: lose trust records rather than accept malformed data)
		return parsed.success ? parsed.data : {};
	} catch {
		return {};
	}
}

/** Atomic write (temp file + rename): tmp name carries a random suffix so concurrent writes in the same process never collide (same pattern as ledger.writeMeta). */
async function writeStore(store: TrustFile): Promise<void> {
	await ensureKeaHomeDir();
	const target = trustStorePath();
	const tmp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
	try {
		await Bun.write(tmp, JSON.stringify(store, null, 2));
		await rename(tmp, target);
	} catch (err) {
		await rm(tmp, { force: true }).catch(() => {});
		throw err;
	}
}

export async function isFolderTrusted(cwd: string): Promise<boolean> {
	const store = await readStore();
	const root = canonical(cwd);
	// records are only ever written with value.root === key, so presence means trusted
	return store.folders?.[root] !== undefined;
}

// Trust a directory; write failure silently stays untrusted (ask again next time).
export async function trustFolder(cwd: string): Promise<void> {
	try {
		const store = await readStore();
		const root = canonical(cwd);
		store.folders = { ...(store.folders ?? {}), [root]: { root, trustedAt: new Date().toISOString() } };
		await writeStore(store);
	} catch {
		// write failure keeps it untrusted
	}
}

/** Trust info + the list of project-level MCP servers that would be released by the gate (shown in the trust prompt). */
export async function getWorkspaceTrustInfo(cwd: string): Promise<{ trusted: boolean; gatedMcpServers: string[] }> {
	const trusted = await isFolderTrusted(cwd);
	if (trusted) return { trusted, gatedMcpServers: [] };
	try {
		const file = Bun.file(join(cwd, ".kea", "mcp.json"));
		if (!(await file.exists())) return { trusted, gatedMcpServers: [] };
		const parsed = McpConfigFileSchema.safeParse(await file.json());
		const names = Object.keys(parsed.success ? parsed.data.mcpServers : {});
		return { trusted, gatedMcpServers: names };
	} catch {
		return { trusted, gatedMcpServers: [] };
	}
}

/** headless (no TUI) trust confirmation: ask via readline when untrusted; refuse directly in non-interactive environments (fail-closed). */
export async function ensureTrustHeadless(cwd: string): Promise<boolean> {
	if (await isFolderTrusted(cwd)) return true;
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error("This directory is not trusted yet. Run interactive kea to confirm trust before headless mode.");
		return false;
	}
	console.log(
		"First kea run in this directory. Trusting allows: loading project-level MCP servers, writing .kea/ state.",
	);
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`Trust directory ${cwd}? (y/N) `)).trim().toLowerCase();
		if (answer === "y" || answer === "yes") {
			await trustFolder(cwd);
			return true;
		}
		return false;
	} finally {
		rl.close();
	}
}

// remove the directory's trust record
export async function untrustFolder(cwd: string): Promise<void> {
	try {
		const store = await readStore();
		const root = canonical(cwd);
		if (!store.folders?.[root]) return;
		delete store.folders[root];
		await writeStore(store);
	} catch {
		// write failure is silent (keeps the existing trust state)
	}
}
