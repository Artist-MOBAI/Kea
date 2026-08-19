import { Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type MemoryKind = "fact" | "decision" | "lesson";
export type MemorySource = "memory" | "notes";

export interface MemoryEntry {
	id: number;
	ts: number;
	source: MemorySource;
	kind: MemoryKind | null;
	text: string;
}

const MAX_INJECTED_CHARS = 4000;

export function memoryDbPath(cwd: string): string {
	return join(cwd, ".kea", "memory.sqlite");
}

/** Tolerate only FTS5 query parse errors (rare syntax residue after sanitizing); real SQL failures must propagate, never masquerade as "no hits". */
export function isFtsQueryParseError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return /^fts5: syntax error/i.test(err.message) || /unterminated string/i.test(err.message);
}

export class MemoryStore {
	private readonly db: Database;
	// prepared statements: built after the table DDL, released together with db.close
	private readonly insertStmt: Statement;
	private readonly recallStmt: Statement;
	private readonly injectionStmt: Statement;
	private readonly tailStmt: Statement;

	constructor(cwd: string) {
		const path = memoryDbPath(cwd);
		mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path, { create: true });
		// multiple processes share the same workspace memory: busy_timeout avoids write-lock SQLITE_BUSY.
		this.db.run("PRAGMA busy_timeout = 15000;");
		// WAL switch needs an exclusive checkpoint, and the busy handler does not always apply to that pragma:
		// first simultaneous open of the same db from multiple processes can hit SQLITE_BUSY directly, so retry in small steps.
		for (let attempt = 0; ; attempt++) {
			try {
				this.db.run("PRAGMA journal_mode = WAL;");
				break;
			} catch (err) {
				if (attempt >= 10 || (err as { code?: string }).code !== "SQLITE_BUSY") throw err;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 + attempt * 50);
			}
		}
		this.db.run(`
			CREATE TABLE IF NOT EXISTS memory (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				source TEXT NOT NULL,
				kind TEXT,
				text TEXT NOT NULL
			);
		`);
		this.db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
				text, content='memory', content_rowid='id'
			);
		`);
		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
				INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
			END;
		`);
		// Backfill: rows that predate the trigger (older builds, manual sqlite edits) leave the FTS index
		// stale. count(*) on an external-content fts table reads the CONTENT table so counts never disagree —
		// the FTS5 integrity-check command is the real detector; on mismatch rebuild once, best-effort.
		try {
			this.db.run("INSERT INTO memory_fts(memory_fts, rank) VALUES('integrity-check', 1)");
		} catch {
			try {
				this.db.run("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
			} catch {
				// best-effort: a failed rebuild leaves recall degraded for old rows, not broken
			}
		}
		this.insertStmt = this.db.query("INSERT INTO memory (ts, source, kind, text) VALUES (?, ?, ?, ?)");
		this.recallStmt = this.db.query(
			`SELECT m.* FROM memory_fts f JOIN memory m ON m.id = f.rowid
			 WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?`,
		);
		this.injectionStmt = this.db.query(
			"SELECT ts, kind, text FROM memory WHERE source = 'memory' ORDER BY id DESC LIMIT 200",
		);
		this.tailStmt = this.db.query("SELECT source, kind, ts, text FROM memory ORDER BY id DESC LIMIT 100");
	}

	remember(text: string, kind: MemoryKind = "fact"): void {
		this.insert("memory", kind, text);
	}

	note(text: string): void {
		this.insert("notes", null, text);
	}

	private insert(source: MemorySource, kind: MemoryKind | null, text: string): void {
		const trimmed = text.trim();
		if (trimmed === "") return;
		this.insertStmt.run(Date.now(), source, kind, trimmed);
	}

	recall(query: string, limit = 8): MemoryEntry[] {
		const safe = query.replace(/['"*()^~{}[\]:]/g, " ").trim();
		if (safe === "") return [];
		// bare FTS5 keywords (AND/OR/NOT/NEAR) and a leading "-" parse as operators and would throw MATCH
		// syntax errors the catch below swallows into a silent empty result: drop keyword tokens, quote the
		// rest and match them as literal phrases.
		const terms = safe.split(/\s+/).filter((token) => !/^(and|or|not|near)$/i.test(token));
		if (terms.length === 0) return [];
		const match = terms.map((token) => `"${token}"`).join(" ");
		try {
			const rows = this.recallStmt.all(match, limit) as Array<{
				id: number;
				ts: number;
				source: string;
				kind: string | null;
				text: string;
			}>;
			return rows.map((row) => ({
				id: row.id,
				ts: row.ts,
				source: row.source as MemorySource,
				kind: row.kind as MemoryKind | null,
				text: row.text,
			}));
		} catch (err) {
			// only FTS5 query syntax errors are swallowed; real SQL failures propagate
			if (isFtsQueryParseError(err)) return [];
			throw err;
		}
	}

	injectionText(maxChars = MAX_INJECTED_CHARS): string {
		const rows = this.injectionStmt.all() as Array<{ ts: number; kind: string | null; text: string }>;
		if (rows.length === 0) return "";
		const lines = rows
			.reverse()
			.map((row) => `- [${row.kind ?? "fact"} ${new Date(row.ts).toISOString()}] ${row.text}`);
		const full = lines.join("\n");
		if (full.length <= maxChars) return full;
		return `…[earlier memory truncated]…\n${full.slice(-maxChars)}`;
	}

	tail(maxChars = 2000): string {
		const rows = this.tailStmt.all() as Array<{
			source: string;
			kind: string | null;
			ts: number;
			text: string;
		}>;
		if (rows.length === 0) return "";
		const lines = rows
			.reverse()
			.map(
				(row) =>
					`[${row.source}${row.kind ? `:${row.kind}` : ""}] ${new Date(row.ts).toISOString().slice(0, 16)} ${row.text}`,
			);
		const full = lines.join("\n");
		return full.length <= maxChars ? full : `…${full.slice(-maxChars)}`;
	}

	close(): void {
		// fold the WAL back into the main db file so a closed store leaves no memory.sqlite-wal needing recovery
		try {
			this.db.run("PRAGMA wal_checkpoint(TRUNCATE);");
		} catch {
			// a busy checkpoint (another process holds the db) still leaves a valid wal for the next opener
		}
		this.db.close();
	}
}
