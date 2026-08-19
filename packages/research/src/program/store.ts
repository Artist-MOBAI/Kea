import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { validateProgram } from "./graph.ts";
import { type Program, ProgramSchema } from "./schema.ts";

// Persistence adapter: one program.json per mobai directory. Writes are atomic (tmp + rename) and
// structurally validated before persisting — a malformed program can never reach disk.

export function programPathIn(mobaiDir: string): string {
	return join(mobaiDir, "program.json");
}

export async function loadProgramStrict(mobaiDir: string): Promise<Program | undefined> {
	const path = programPathIn(mobaiDir);
	const file = Bun.file(path);
	if (!(await file.exists())) return undefined;
	let raw: unknown;
	try {
		raw = await file.json();
	} catch (err) {
		throw new Error(`program ledger is corrupted (${path}): ${err instanceof Error ? err.message : String(err)}`);
	}
	const parsed = ProgramSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(`program ledger failed schema validation (${path}): ${parsed.error.message}`);
	}
	return parsed.data;
}

export async function loadProgram(mobaiDir: string): Promise<Program | undefined> {
	try {
		return await loadProgramStrict(mobaiDir);
	} catch (err) {
		// corrupted ≠ absent: report loudly so corruption stays discoverable instead of being
		// indistinguishable from a never-started program
		console.error(`[kea] ${err instanceof Error ? err.message : String(err)} — treating as absent`);
		return undefined;
	}
}

export async function saveProgram(mobaiDir: string, program: Program): Promise<void> {
	const issues = validateProgram(program);
	if (issues.length > 0) {
		throw new Error(`refusing to save invalid program: ${issues.map((i) => `${i.kind} (${i.detail})`).join("; ")}`);
	}
	const finalPath = programPathIn(mobaiDir);
	const tmpPath = `${finalPath}.tmp`;
	await Bun.write(tmpPath, JSON.stringify(program, null, "\t"));
	try {
		await rename(tmpPath, finalPath);
	} catch (err) {
		await unlink(tmpPath).catch(() => {});
		throw err;
	}
}

export async function removeProgram(mobaiDir: string): Promise<boolean> {
	const path = programPathIn(mobaiDir);
	const file = Bun.file(path);
	if (!(await file.exists())) return false;
	await unlink(path);
	return true;
}
