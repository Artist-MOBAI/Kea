import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { JobStatus } from "./types.ts";

export function jobsDir(cwd: string): string {
	return join(cwd, ".kea", "jobs");
}

export function jobDir(cwd: string, jobId: string): string {
	return join(jobsDir(cwd), jobId);
}

export function metaPath(cwd: string, jobId: string): string {
	return join(jobDir(cwd, jobId), "meta.json");
}

export function stdoutPath(cwd: string, jobId: string): string {
	return join(jobDir(cwd, jobId), "stdout.log");
}

export function stderrPath(cwd: string, jobId: string): string {
	return join(jobDir(cwd, jobId), "stderr.log");
}

/** Atomic write (temp file + rename): a crash mid-write won't leave a corrupted meta.json. */
export async function writeMeta(cwd: string, status: JobStatus): Promise<void> {
	await mkdir(jobDir(cwd, status.jobId), { recursive: true });
	const target = metaPath(cwd, status.jobId);
	// concurrent settlements of the same job in one process (timeout failJob racing user cancel etc.) would collide on the same tmp path,
	// and both sides rename in sequence → torn write. The tmp name must carry a random suffix; best-effort delete orphan tmp on failure.
	const tmp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
	try {
		await Bun.write(tmp, JSON.stringify(status, null, 2));
		await rename(tmp, target);
	} catch (err) {
		await rm(tmp, { force: true }).catch(() => {});
		throw err;
	}
}

export async function readMeta(cwd: string, jobId: string): Promise<JobStatus | undefined> {
	const file = Bun.file(metaPath(cwd, jobId));
	if (!(await file.exists())) return undefined;
	try {
		return (await file.json()) as JobStatus;
	} catch {
		return undefined;
	}
}

export interface JobScanResult {
	ids: string[];
	/** false = scan IO failed (permission/disk error etc.); ids are meaningless then and the caller must discard them (not treat as "really no jobs") */
	ok: boolean;
}

/**
 * Distinguish "scan failed" from "truly empty": directory missing (ENOENT, fresh workspace) = genuinely
 * empty; other errors (EACCES/EIO etc.) = scan failure. Treating a failure as empty would let the
 * watcher clear its seen set once IO recovers and re-fire onSettled for every settled job.
 */
export async function scanJobIds(cwd: string): Promise<JobScanResult> {
	const glob = new Bun.Glob("*/meta.json");
	const ids: string[] = [];
	try {
		for await (const file of glob.scan({ cwd: jobsDir(cwd), onlyFiles: true })) {
			ids.push(file.split("/")[0] as string);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { ids: [], ok: true };
		return { ids: [], ok: false };
	}
	return { ids, ok: true };
}

/** Compat for old callers: errors and empty both become [] (best-effort scan scenarios). Use scanJobIds when success/failure matters. */
export async function listJobIds(cwd: string): Promise<string[]> {
	return (await scanJobIds(cwd)).ids;
}

export async function readLog(path: string): Promise<string> {
	const file = Bun.file(path);
	if (!(await file.exists())) return "";
	return file.text();
}
