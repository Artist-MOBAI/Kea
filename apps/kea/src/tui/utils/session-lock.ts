import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

// Single-writer discipline for session files: pi's JSONL repo validates a strict seq/parent chain —
// two processes appending to one session interleave into "non-consecutive seq" corruption that the
// next open rejects wholesale. A pid lockfile refuses the second process up front.

export interface SessionLockResult {
	acquired: boolean;
	reason?: string;
}

// This process's approximate start epoch: lock files carry it so a reused pid with a mismatched
// start is recognized as a dead holder instead of a live one.
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
const PID_REUSE_TOLERANCE_MS = 5000;
const MAX_ACQUIRE_ATTEMPTS = 3;

const heldLocks = new Set<string>();

/** Session files this process currently holds a lock for. */
export function heldSessionLocks(): string[] {
	return [...heldLocks];
}

export function releaseAllSessionLocks(): void {
	for (const file of [...heldLocks]) releaseSessionLock(file);
}

export function releaseSessionLocksExcept(sessionFile: string): void {
	for (const file of [...heldLocks]) {
		if (file !== sessionFile) releaseSessionLock(file);
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

// ps elapsed formats: MM:SS, HH:MM:SS, DD-HH:MM:SS (seconds may carry a fractional part).
function parseEtimeSeconds(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	let days = 0;
	let rest = trimmed;
	const dash = trimmed.indexOf("-");
	if (dash >= 0) {
		const d = Number(trimmed.slice(0, dash));
		if (!Number.isFinite(d) || d < 0) return undefined;
		days = d;
		rest = trimmed.slice(dash + 1);
	}
	const parts = rest.split(":").map(Number);
	if (parts.length === 0 || parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return undefined;
	const seconds = parts.pop() ?? 0;
	const minutes = parts.pop() ?? 0;
	const hours = parts.pop() ?? 0;
	return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

function estimatePidStart(pid: number): number | undefined {
	try {
		const out = Bun.spawnSync(["ps", "-o", "etime=", "-p", String(pid)]);
		if (out.exitCode !== 0) return undefined;
		const seconds = parseEtimeSeconds(out.stdout.toString());
		return seconds === undefined ? undefined : Date.now() - seconds * 1000;
	} catch {
		return undefined;
	}
}

function readHolder(raw: string): { pid?: number; startedAt?: number } {
	const [pidRaw, startedRaw] = raw.trim().split(/\s+/);
	const pid = Number(pidRaw);
	if (!Number.isInteger(pid) || pid <= 0) return {};
	const startedAt = startedRaw !== undefined ? Number(startedRaw) : undefined;
	return { pid, startedAt: Number.isFinite(startedAt) ? startedAt : undefined };
}

// A foreign pid counts as the live holder only when liveness holds AND (for startedAt-bearing
// locks) the pid's real start matches the stored one — a mismatch means pid reuse, i.e. dead holder.
function foreignHolderAlive(pid: number, startedAt: number | undefined): boolean {
	if (pid === process.pid) return false;
	if (!isPidAlive(pid)) return false;
	if (startedAt === undefined) return true;
	const estimated = estimatePidStart(pid);
	if (estimated === undefined) return true;
	return Math.abs(startedAt - estimated) <= PID_REUSE_TOLERANCE_MS;
}

// Test seam: invoked between the dead-holder judgment and the takeover rename, letting tests
// simulate a racing writer/renamer inside the TOCTOU window.
let takeoverRaceHook: ((lockPath: string, raw: string) => void) | undefined;

export function setTakeoverRaceHookForTests(hook: ((lockPath: string, raw: string) => void) | undefined): void {
	takeoverRaceHook = hook;
}

export function acquireSessionLock(sessionFile: string): SessionLockResult {
	const lockPath = `${sessionFile}.lock`;
	const content = `${process.pid} ${PROCESS_STARTED_AT}\n`;
	for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
		try {
			// wx = fail on exist: creation is the atomic test-and-set (existsSync+write is TOCTOU-racy)
			writeFileSync(lockPath, content, { flag: "wx" });
			heldLocks.add(sessionFile);
			return { acquired: true };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		let raw: string;
		try {
			raw = readFileSync(lockPath, "utf8");
		} catch {
			continue;
		}
		const holder = readHolder(raw);
		if (holder.pid !== undefined && foreignHolderAlive(holder.pid, holder.startedAt)) {
			return {
				acquired: false,
				reason: `session is open in another Kea process (pid ${holder.pid}) — close that process or switch to a fork first`,
			};
		}
		// Dead/invalid holder: take over via rename — atomic, so of N racers judging the same dead
		// bytes only one can move the file; the losers see ENOENT and loop back to the wx attempt.
		takeoverRaceHook?.(lockPath, raw);
		const takeoverPath = `${lockPath}.takeover-${process.pid}`;
		try {
			renameSync(lockPath, takeoverPath);
		} catch {
			continue;
		}
		let judgedBytes = false;
		try {
			judgedBytes = readFileSync(takeoverPath, "utf8") === raw;
		} catch {}
		if (judgedBytes) {
			try {
				rmSync(takeoverPath, { force: true });
			} catch {}
			continue;
		}
		// Different/unknown bytes: a fresh holder rewrote the lock before our rename — restore it,
		// never destroy it (link failing EEXIST means a third party already created one: keep theirs).
		try {
			linkSync(takeoverPath, lockPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
				try {
					rmSync(takeoverPath, { force: true });
				} catch {}
				throw err;
			}
		}
		try {
			rmSync(takeoverPath, { force: true });
		} catch {}
	}
	return { acquired: false, reason: "session lock is contested — close other Kea processes and retry" };
}

export function releaseSessionLock(sessionFile: string): void {
	heldLocks.delete(sessionFile);
	const lockPath = `${sessionFile}.lock`;
	try {
		const pid = Number(readFileSync(lockPath, "utf8").trim().split(/\s+/)[0]);
		// only the holder releases; a taken-over lock belongs to the newer process
		if (pid === process.pid) rmSync(lockPath, { force: true });
	} catch {
		// missing/unreadable lock file: nothing to remove on disk
	}
}
