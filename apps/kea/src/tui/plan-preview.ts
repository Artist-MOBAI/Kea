/** Plan preview read cap: take only a head slice; huge files / network FS must not freeze the event loop. */
export const PLAN_PREVIEW_MAX_BYTES = 200 * 1024;

/**
 * Read plan file text (head slice capped at maxBytes). Returns undefined when unreadable (missing
 * path / directory / no permission) — the read runs inside the approval flow, so failure must
 * degrade to a hint line and never throw (a throw rejects the approval promise → the panel never
 * appears → the user is stuck in plan mode).
 */
export async function readPlanPreviewText(
	planPath: string | undefined,
	maxBytes = PLAN_PREVIEW_MAX_BYTES,
): Promise<string | undefined> {
	if (!planPath) return undefined;
	try {
		const file = Bun.file(planPath);
		const len = Math.min(Math.max(0, file.size), Math.max(0, maxBytes));
		// size=0 must distinguish empty file ("") from missing path (undefined); directories have non-zero size and their slice read throws EISDIR into catch
		if (len === 0) return (await file.exists()) ? "" : undefined;
		return await file.slice(0, len).text();
	} catch {
		return undefined;
	}
}
