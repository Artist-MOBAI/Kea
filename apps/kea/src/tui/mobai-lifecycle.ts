import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

// Mobai lifecycle UX state: the `paused` marker and the upcoming-mobai queue are SESSION-SCOPED
// UX-layer facts stored next to the session's mobai ledger. They never touch the program schema —
// "complete" stays a machine-set fact; pause/cancel/queue are user intents.

export function pausedMarkerPath(mobaiDir: string): string {
	return join(mobaiDir, "paused");
}

export async function isMobaiPaused(mobaiDir: string): Promise<boolean> {
	return await Bun.file(pausedMarkerPath(mobaiDir)).exists();
}

export async function pauseMobai(mobaiDir: string): Promise<boolean> {
	if (await isMobaiPaused(mobaiDir)) return false;
	await Bun.write(pausedMarkerPath(mobaiDir), `${new Date().toISOString()}\n`);
	return true;
}

export async function resumeMobai(mobaiDir: string): Promise<boolean> {
	if (!(await isMobaiPaused(mobaiDir))) return false;
	await rm(pausedMarkerPath(mobaiDir), { force: true });
	return true;
}

export function queuePath(mobaiDir: string): string {
	return join(mobaiDir, "queue.json");
}

export async function loadQueue(mobaiDir: string): Promise<string[]> {
	try {
		const raw = await Bun.file(queuePath(mobaiDir)).json();
		const objectives = (raw as { objectives?: unknown }).objectives;
		if (!Array.isArray(objectives)) return [];
		return objectives.filter((o): o is string => typeof o === "string" && o.trim() !== "");
	} catch (err) {
		// A corrupt queue is user-visible data loss in the making (the next saveQueue overwrites it) — warn, don't hide it.
		console.warn(
			`[kea] unreadable mobai queue at ${queuePath(mobaiDir)} (${err instanceof Error ? err.message : String(err)}); treating as empty`,
		);
		return [];
	}
}

export async function saveQueue(mobaiDir: string, objectives: string[]): Promise<void> {
	const finalPath = queuePath(mobaiDir);
	const tmpPath = `${finalPath}.tmp`;
	const payload = JSON.stringify({ objectives }, null, "\t");
	await Bun.write(tmpPath, payload);
	try {
		// POSIX rename replaces atomically — same pattern as the program store (no rm-then-rename gap).
		await rename(tmpPath, finalPath);
	} catch {
		await Bun.write(finalPath, payload);
		await rm(tmpPath, { force: true });
	}
}

export async function shiftQueue(mobaiDir: string): Promise<string | undefined> {
	const objectives = await loadQueue(mobaiDir);
	if (objectives.length === 0) return undefined;
	const [next, ...rest] = objectives;
	await saveQueue(mobaiDir, rest);
	return next;
}

export async function frontQueue(mobaiDir: string): Promise<string | undefined> {
	const objectives = await loadQueue(mobaiDir);
	return objectives[0];
}

// Rollback partner of shiftQueue: a consumed head whose submission never entered the session must be
// written back to the FRONT or the objective is lost forever.
export async function unshiftQueue(mobaiDir: string, objective: string): Promise<void> {
	const objectives = await loadQueue(mobaiDir);
	await saveQueue(mobaiDir, [objective, ...objectives]);
}
