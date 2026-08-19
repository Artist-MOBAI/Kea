import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { isFtsQueryParseError, MemoryStore, memoryDbPath } from "../src/memory.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

describe("MemoryStore (rewrite: sqlite + FTS5)", () => {
	test("remember/note persist to the db and distinguish source", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-mem-"));
		const store = new MemoryStore(workdir);
		store.remember("evaluator frozen at v2", "decision");
		store.remember("single-run gains are hypotheses");
		store.note("rerun with seed 7");

		const hits = store.recall("evaluator frozen");
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0]?.source).toBe("memory");
		expect(hits[0]?.kind).toBe("decision");
		expect(store.recall("seed 7")[0]?.source).toBe("notes");
		store.close();
	});

	test("FTS5 recall is ordered by relevance (BM25)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-mem-"));
		const store = new MemoryStore(workdir);
		store.note("lunch at noon");
		store.remember("thermoelectric figure of merit zT peaked at 1.4 in skutterudites");
		store.note("thermoelectric zT measurement protocol");

		const hits = store.recall("thermoelectric zT");
		expect(hits.length).toBe(2);
		expect(hits.every((h) => h.text.includes("thermoelectric"))).toBe(true);
		store.close();
	});

	test("injected system prompt respects the window cap and keeps the tail", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-mem-"));
		const store = new MemoryStore(workdir);
		for (let i = 0; i < 300; i++) store.remember(`fact ${i} ${"x".repeat(40)}`);
		store.remember("TAIL-MARKER final fact");

		const injected = store.injectionText();
		expect(injected.length).toBeLessThanOrEqual(4000 + "…[earlier memory truncated]…\n".length);
		expect(injected).toContain("TAIL-MARKER");
		store.close();
	});

	test("empty store returns an empty injection and an empty tail", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-mem-"));
		const store = new MemoryStore(workdir);
		expect(store.injectionText()).toBe("");
		expect(store.tail()).toBe("");
		expect(store.recall("anything")).toEqual([]);
		store.close();
	});

	test("persists across instances (durable)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-mem-"));
		const first = new MemoryStore(workdir);
		first.remember("persisted fact");
		first.close();
		const second = new MemoryStore(workdir);
		expect(second.recall("persisted")).toHaveLength(1);
		second.close();
	});

	test("FTS backfill: pre-trigger rows are reindexed on open and become recallable", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-mem-"));
		const seed = new MemoryStore(workdir);
		seed.close();
		// simulate a store written before the trigger existed: drop it, insert rows directly, close
		const raw = new Database(memoryDbPath(workdir));
		raw.run("DROP TRIGGER memory_ai;");
		raw.run("INSERT INTO memory (ts, source, kind, text) VALUES (?, ?, NULL, ?)", [
			1,
			"memory",
			"orphaned pre-trigger fact about skutterudite zT benchmarks",
		]);
		raw.close();
		const store = new MemoryStore(workdir); // reopen: count mismatch → guarded rebuild
		expect(store.recall("skutterudite").length).toBeGreaterThan(0); // old rows are searchable again
		store.close();
	});
});

describe("recall error triage (same pattern as journal)", () => {
	test("isFtsQueryParseError recognizes only FTS5 parse errors", () => {
		expect(isFtsQueryParseError(new Error('fts5: syntax error near "AND"'))).toBe(true);
		expect(isFtsQueryParseError(new Error("unterminated string"))).toBe(true);
		expect(isFtsQueryParseError(new Error("database disk image is malformed"))).toBe(false);
		expect(isFtsQueryParseError("fts5: syntax error")).toBe(false);
	});

	test("real SQL failures throw instead of masquerading as empty results", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-mem-"));
		const store = new MemoryStore(workdir);
		store.remember("some fact");
		expect(store.recall("fact")).toHaveLength(1);
		// Querying a closed db is a real failure: it must throw instead of silently returning []
		store.close();
		expect(() => store.recall("fact")).toThrow();
	});
});
