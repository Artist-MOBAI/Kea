import type { Statement } from "bun:sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isFtsQueryParseError } from "@kea/core";
import { z } from "zod";

export const JOURNAL_EVENT_TYPES = [
	"gap_opened",
	"gap_updated",
	"hypothesis_proposed",
	"belief_updated",
	"evaluator_frozen",
	"run_recorded",
	"claim_made",
	"claim_verified",
	"novelty_checked",
	"note",
] as const;

export const JournalEventSchema = z.object({
	type: z.enum(JOURNAL_EVENT_TYPES),

	payload: z.record(z.string(), z.unknown()),
	refId: z.string().optional(),
});
export type JournalEventInput = z.infer<typeof JournalEventSchema>;

export interface JournalEvent extends JournalEventInput {
	id: number;
	ts: number;
}

export function journalPath(cwd: string): string {
	return join(cwd, ".kea", "journal.sqlite");
}

interface EventRow {
	id: number;
	ts: number;
	type: string;
	ref_id: string | null;
	payload: string;
}

function mapRow(row: EventRow): JournalEvent {
	return {
		id: row.id,
		ts: row.ts,
		type: row.type as JournalEvent["type"],
		refId: row.ref_id ?? undefined,
		payload: JSON.parse(row.payload) as Record<string, unknown>,
	};
}

export class Journal {
	private readonly db: Database;
	private readonly insertStmt: Statement<unknown[]>;

	constructor(cwd: string) {
		const path = journalPath(cwd);
		mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path, { create: true });
		// Multiple kea processes can share one workspace journal; with the default
		// busy_timeout of 0 a writer hitting a held WAL write lock throws SQLITE_BUSY
		// straight out of append(). Wait up to 15s for the lock instead.
		this.db.run("PRAGMA busy_timeout = 15000;");
		// WAL switching needs an exclusive checkpoint, and the busy handler does not always apply to that pragma:
		// when multiple processes first open the same journal concurrently it can throw SQLITE_BUSY immediately, so retry in small steps.
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
			CREATE TABLE IF NOT EXISTS events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				type TEXT NOT NULL,
				ref_id TEXT,
				payload TEXT NOT NULL
			);
		`);
		this.db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
				type, payload, content='events', content_rowid='id'
			);
		`);

		this.db.run(`
			CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
				INSERT INTO events_fts(rowid, type, payload) VALUES (new.id, new.type, new.payload);
			END;
		`);
		// Backfill: rows that predate the trigger (older builds, manual sqlite edits) leave the FTS index
		// stale. count(*) on an external-content fts table reads the CONTENT table so counts never disagree —
		// the FTS5 integrity-check command is the real detector; on mismatch rebuild once, best-effort.
		try {
			this.db.run("INSERT INTO events_fts(events_fts, rank) VALUES('integrity-check', 1)");
		} catch {
			try {
				this.db.run("INSERT INTO events_fts(events_fts) VALUES('rebuild')");
			} catch {
				// best-effort: a failed rebuild leaves recall degraded for old rows, not broken
			}
		}
		this.insertStmt = this.db.prepare("INSERT INTO events (ts, type, ref_id, payload) VALUES (?, ?, ?, ?)");
	}

	append(input: JournalEventInput): number {
		const event = JournalEventSchema.parse(input);
		const result = this.insertStmt.run(Date.now(), event.type, event.refId ?? null, JSON.stringify(event.payload));
		return Number(result.lastInsertRowid);
	}

	list(options: { type?: string; refId?: string; limit?: number } = {}): JournalEvent[] {
		const { where, params } = this.buildWhere(options);
		const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
		const rows = this.db
			.prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ?`)
			.all(...params, limit) as EventRow[];
		return rows.map(mapRow);
	}

	// No "most recent 100" recency cap from list(): full scan newest to oldest, so early events
	// (e.g. a baseline run_recorded) remain searchable.
	lookup(options: { type?: string; refId?: string }): JournalEvent[] {
		const { where, params } = this.buildWhere(options);
		const rows = this.db.prepare(`SELECT * FROM events ${where} ORDER BY id DESC`).all(...params) as EventRow[];
		return rows.map(mapRow);
	}

	recall(query: string, limit = 10): JournalEvent[] {
		const safe = query.replace(/['"*()^~{}[\]:]/g, " ").trim();
		if (safe === "") return [];
		// Bare FTS5 keywords (AND/OR/NOT/NEAR) parse as operators, so a natural query ending in "and" is a
		// syntax error. Drop keyword tokens and quote the rest so every remaining term matches literally.
		const terms = safe.split(/\s+/).filter((token) => !/^(and|or|not|near)$/i.test(token));
		if (terms.length === 0) return [];
		const match = terms.map((token) => `"${token}"`).join(" ");
		try {
			const rows = this.db
				.prepare(
					`SELECT e.* FROM events_fts f JOIN events e ON e.id = f.rowid
					 WHERE events_fts MATCH ? ORDER BY bm25(events_fts) LIMIT ?`,
				)
				.all(match, limit) as EventRow[];
			return rows.map(mapRow);
		} catch (err) {
			if (isFtsQueryParseError(err)) return [];
			throw err;
		}
	}

	close(): void {
		this.db.close();
	}

	private buildWhere(options: { type?: string; refId?: string }): { where: string; params: (string | number)[] } {
		const clauses: string[] = [];
		const params: (string | number)[] = [];
		if (options.type) {
			clauses.push("type = ?");
			params.push(options.type);
		}
		if (options.refId) {
			clauses.push("ref_id = ?");
			params.push(options.refId);
		}
		return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
	}
}
