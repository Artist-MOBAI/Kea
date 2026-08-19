import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { Journal, journalPath } from "../src/journal.ts";

// Absolute path so concurrent worker subprocesses can import it (their cwd is not fixed)
const journalSrcPath = fileURLToPath(new URL("../src/journal.ts", import.meta.url));

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

describe("journal event sourcing (M3)", () => {
	test("append/list round-trip with typed events", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-journal-"));
		const journal = new Journal(workdir);
		journal.append({ type: "gap_opened", refId: "gap-1", payload: { statement: "SPR gap in skutterudites" } });
		journal.append({ type: "claim_made", refId: "claim-1", payload: { statement: "filling lowers κ" } });
		journal.append({ type: "note", payload: { text: "negative result: Bi2Te3 baseline reproduced" } });

		expect(journal.list()).toHaveLength(3);
		expect(journal.list({ type: "claim_made" })[0]?.refId).toBe("claim-1");
		journal.close();
	});

	test("FTS5 recall finds events by content (BM25)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-journal-"));
		const journal = new Journal(workdir);
		journal.append({ type: "note", payload: { text: "thermoelectric figure of merit zT peaked at 1.4" } });
		journal.append({ type: "note", payload: { text: "unrelated lunch note" } });

		const hits = journal.recall("thermoelectric zT");
		expect(hits.length).toBeGreaterThan(0);
		expect(JSON.stringify(hits[0]?.payload)).toContain("thermoelectric");
		journal.close();
	});

	test("invalid event types are rejected", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-journal-"));
		const journal = new Journal(workdir);
		expect(() => journal.append({ type: "bogus" as never, payload: {} })).toThrow();
		journal.close();
	});

	test("persists across reopen (durable)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-journal-"));
		const first = new Journal(workdir);
		first.append({ type: "note", payload: { text: "persisted" } });
		first.close();
		const second = new Journal(workdir);
		expect(second.list()).toHaveLength(1);
		second.close();
	});

	test("FTS backfill: pre-trigger rows rebuild the index on open and become recallable", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-journal-"));
		const seed = new Journal(workdir);
		seed.close();
		// simulate a ledger written before the trigger existed: drop it, insert rows directly, close
		const raw = new Database(journalPath(workdir));
		raw.run("DROP TRIGGER events_ai;");
		raw.run("INSERT INTO events (ts, type, ref_id, payload) VALUES (?, ?, NULL, ?)", [
			1,
			"note",
			JSON.stringify({ text: "orphaned pre-trigger row about skutterudite filling fractions" }),
		]);
		raw.close();
		const journal = new Journal(workdir); // reopen: count mismatch → guarded rebuild
		expect(journal.list()).toHaveLength(1);
		expect(journal.recall("skutterudite").length).toBeGreaterThan(0); // old rows are searchable again
		journal.close();
	});

	test("recall tolerates FTS5 keywords (and/or/not): no longer silently returns empty", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-journal-"));
		const journal = new Journal(workdir);
		journal.append({ type: "note", payload: { text: "stress and coping reduce burnout" } });
		journal.append({ type: "note", payload: { text: "unrelated lunch note" } });

		expect(journal.recall("stress and coping").length).toBeGreaterThan(0);
		expect(journal.recall("stress and").length).toBeGreaterThan(0); // trailing dangling keyword: syntax error → [] before the fix
		expect(journal.recall("burnout or").length).toBeGreaterThan(0);
		expect(journal.recall("not")).toEqual([]); // bare keyword query: empty result but no throw
		journal.close();
	});

	test("busy_timeout: two processes concurrently writing the same journal never throw SQLITE_BUSY", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-journal-"));
		// Two processes construct and write to the Journal concurrently: with busy timeout 0, lock contention during the WAL switch/table-creation phase
		// makes one side throw SQLITE_BUSY immediately (reproduced 3/3); with busy_timeout + WAL retry both succeed.
		const worker = [
			`import { Journal } from ${JSON.stringify(journalSrcPath)};`,
			"let errors = 0;",
			"const j = new Journal(process.argv[2]);",
			"for (let i = 0; i < 50; i++) {",
			"	try {",
			'		j.append({ type: "note", payload: { text: "n" + i + "-" + process.argv[3] } });',
			"	} catch {",
			"		errors++;",
			"	}",
			"}",
			"console.log(String(errors));",
			"j.close();",
		].join("\n");
		const scriptPath = join(workdir, "journal-worker.ts");
		await Bun.write(scriptPath, worker);
		const a = Bun.spawn(["bun", "run", scriptPath, workdir, "A"], { stdout: "pipe", stderr: "pipe" });
		const b = Bun.spawn(["bun", "run", scriptPath, workdir, "B"], { stdout: "pipe", stderr: "pipe" });
		const [outA, outB] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
		const [errA, errB] = await Promise.all([new Response(a.stderr).text(), new Response(b.stderr).text()]);
		expect(await a.exited, errA).toBe(0);
		expect(await b.exited, errB).toBe(0);
		expect(outA.trim()).toBe("0");
		expect(outB.trim()).toBe("0");
	}, 30_000);
});
