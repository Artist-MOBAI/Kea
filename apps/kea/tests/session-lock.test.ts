import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
	acquireSessionLock,
	heldSessionLocks,
	releaseAllSessionLocks,
	releaseSessionLock,
	releaseSessionLocksExcept,
	setTakeoverRaceHookForTests,
} from "../src/tui/utils/session-lock.ts";

let dir: string;

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

const sessionFile = () => {
	dir = mkdtempSync(join(tmpdir(), "kea2-sessionlock-"));
	return join(dir, "session.jsonl");
};

describe("session-lock (single-writer discipline)", () => {
	test("no lock: acquire writes pid+startedAt; after release the lock file disappears and can be re-acquired", () => {
		const file = sessionFile();
		const acquired = acquireSessionLock(file);
		expect(acquired.acquired).toBe(true);
		const [pid, startedAt] = readFileSync(`${file}.lock`, "utf8").trim().split(/\s+/);
		expect(pid).toBe(String(process.pid));
		expect(Number(startedAt)).toBeGreaterThan(0);
		expect(heldSessionLocks()).toContain(file);
		releaseSessionLock(file);
		expect(existsSync(`${file}.lock`)).toBe(false);
		expect(heldSessionLocks()).not.toContain(file);
		// re-acquire after release
		expect(acquireSessionLock(file).acquired).toBe(true);
		releaseSessionLock(file);
	});

	test("live lock (foreign pid holds it, startedAt matches its real start): refused atomically with guidance", () => {
		const file = sessionFile();
		writeFileSync(`${file}.lock`, `${process.pid} ${Date.now()}\n`);
		// our own pid re-acquires (same-process handle takeover is allowed)
		expect(acquireSessionLock(file).acquired).toBe(true);
		releaseSessionLock(file);

		// foreign live pid with a startedAt matching its real start: refused without touching the file
		const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		try {
			const before = `${proc.pid} ${Date.now()}\n`;
			writeFileSync(`${file}.lock`, before);
			const denied = acquireSessionLock(file);
			expect(denied.acquired).toBe(false);
			expect(denied.reason).toContain("another Kea process");
			expect(denied.reason).toContain(String(proc.pid));
			expect(readFileSync(`${file}.lock`, "utf8")).toBe(before);
		} finally {
			proc.kill();
		}
	});

	test("bare pid lock file (no startedAt) keeps the old behavior: live pid refused", () => {
		const file = sessionFile();
		const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		try {
			writeFileSync(`${file}.lock`, `${proc.pid}\n`);
			expect(acquireSessionLock(file).acquired).toBe(false);
		} finally {
			proc.kill();
		}
	});

	test("dead lock (pid gone, old and new formats): takeover rewrites to the new format", () => {
		const file = sessionFile();
		writeFileSync(`${file}.lock`, "999999999\n");
		const acquired = acquireSessionLock(file);
		expect(acquired.acquired).toBe(true);
		expect(readFileSync(`${file}.lock`, "utf8").trim().split(/\s+/)[0]).toBe(String(process.pid));
		releaseSessionLock(file);

		writeFileSync(`${file}.lock`, `999999999 ${Date.now() - 60_000}\n`);
		expect(acquireSessionLock(file).acquired).toBe(true);
		releaseSessionLock(file);
	});

	test("pid reuse: live pid but startedAt far beyond tolerance → treated as a dead holder and taken over", () => {
		const file = sessionFile();
		const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		try {
			writeFileSync(`${file}.lock`, `${proc.pid} ${Date.now() - 3_600_000}\n`);
			expect(acquireSessionLock(file).acquired).toBe(true);
			expect(readFileSync(`${file}.lock`, "utf8").trim().split(/\s+/)[0]).toBe(String(process.pid));
		} finally {
			proc.kill();
		}
		releaseSessionLock(file);
	});

	test("release runs only for the holder: foreign lock untouched (new format also compares only the pid field)", () => {
		const file = sessionFile();
		writeFileSync(`${file}.lock`, "999999999\n");
		releaseSessionLock(file);
		expect(existsSync(`${file}.lock`)).toBe(true);
		writeFileSync(`${file}.lock`, `999999999 ${Date.now()}\n`);
		releaseSessionLock(file);
		expect(existsSync(`${file}.lock`)).toBe(true);
	});
});

describe("takeover protocol (rename-verify-restore, TOCTOU closed)", () => {
	const takeoverLitter = (file: string): string[] => readdirSync(dirname(file)).filter((f) => f.includes(".takeover-"));

	test("dead holder: rename takeover succeeds, held set updated, no takeover litter", () => {
		const file = sessionFile();
		writeFileSync(`${file}.lock`, `999999999 ${Date.now() - 60_000}\n`);
		const acquired = acquireSessionLock(file);
		expect(acquired.acquired).toBe(true);
		expect(heldSessionLocks()).toContain(file);
		expect(readFileSync(`${file}.lock`, "utf8").trim().split(/\s+/)[0]).toBe(String(process.pid));
		expect(takeoverLitter(file)).toEqual([]);
		releaseSessionLock(file);
	});

	test("takeover race: rewrite between verdict and rename → restored not deleted, refused (regression)", () => {
		const file = sessionFile();
		const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		try {
			const live = `${proc.pid} ${Date.now()}\n`;
			writeFileSync(`${file}.lock`, "999999999 123\n"); // judged-dead bytes at read time
			setTakeoverRaceHookForTests(() => writeFileSync(`${file}.lock`, live)); // racer rewrites mid-window
			try {
				const denied = acquireSessionLock(file);
				expect(denied.acquired).toBe(false);
				expect(denied.reason).toContain("another Kea process");
				expect(readFileSync(`${file}.lock`, "utf8")).toBe(live); // restored, not deleted
				expect(takeoverLitter(file)).toEqual([]);
			} finally {
				setTakeoverRaceHookForTests(undefined);
			}
		} finally {
			proc.kill();
		}
	});

	test("two-process rename race: other side renames first → our rename gets ENOENT → loop retries safely", () => {
		const file = sessionFile();
		writeFileSync(`${file}.lock`, "999999999 123\n");
		const racedAway = join(dirname(file), "raced-away.lock");
		setTakeoverRaceHookForTests(() => renameSync(`${file}.lock`, racedAway)); // other racer renamed first
		try {
			const acquired = acquireSessionLock(file);
			expect(acquired.acquired).toBe(true);
			expect(readFileSync(`${file}.lock`, "utf8")).toContain(String(process.pid));
			expect(takeoverLitter(file)).toEqual([]);
		} finally {
			setTakeoverRaceHookForTests(undefined);
			rmSync(racedAway, { force: true });
			releaseSessionLock(file);
		}
	});
});

describe("lock registry (in-process set of held session locks)", () => {
	test("acquire records, release removes; releaseAll clears", () => {
		const a = sessionFile();
		const b = sessionFile();
		acquireSessionLock(a);
		acquireSessionLock(b);
		expect(heldSessionLocks().sort()).toEqual([a, b].sort());
		releaseAllSessionLocks();
		expect(heldSessionLocks()).toEqual([]);
		expect(existsSync(`${a}.lock`)).toBe(false);
		expect(existsSync(`${b}.lock`)).toBe(false);
	});

	test("releaseSessionLocksExcept keeps only the named session's lock", () => {
		const a = sessionFile();
		const b = sessionFile();
		const c = sessionFile();
		acquireSessionLock(a);
		acquireSessionLock(b);
		acquireSessionLock(c);
		releaseSessionLocksExcept(b);
		expect(heldSessionLocks()).toEqual([b]);
		expect(existsSync(`${a}.lock`)).toBe(false);
		expect(existsSync(`${c}.lock`)).toBe(false);
		expect(existsSync(`${b}.lock`)).toBe(true);
		releaseSessionLock(b);
	});
});
