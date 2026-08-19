import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadProgram } from "@kea/research";

// Session-scoped mobai directory for the interactive TUI: the mobai is session state, not workspace
// state — a new session does not inherit the previous session's mobai. The headless `kea mobai`
// continue-mode keeps the workspace file `<cwd>/.kea/mobai.json`.
export function sessionMobaiDir(cwd: string, sessionId: string): string {
	return join(cwd, ".kea", "mobai", sessionId);
}

/** The newest session (other than the current one) that still has an active program — surfacing it
 * beats letting the user assume the objective vanished after /exit started a fresh session. Session
 * ids are ULIDs, so lexicographic order is creation order: the newest orphan is the relevant one. */
export async function findOrphanMobai(
	cwd: string,
	currentSessionId: string,
): Promise<{ sid: string; paused: boolean } | undefined> {
	let entries: string[];
	try {
		entries = await readdir(join(cwd, ".kea", "mobai"));
	} catch {
		return undefined;
	}
	let found: { sid: string; paused: boolean } | undefined;
	for (const entry of entries.toSorted()) {
		if (entry === currentSessionId) continue;
		try {
			const dir = join(cwd, ".kea", "mobai", entry);
			const program = await loadProgram(dir);
			if (program?.status !== "active") continue;
			found = { sid: entry, paused: await Bun.file(join(dir, "paused")).exists() };
		} catch {
			// unreadable/stale dirs are skipped
		}
	}
	return found;
}
