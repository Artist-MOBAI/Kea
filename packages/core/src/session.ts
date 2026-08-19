import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	defaultContextEntryTransform,
	type Entry,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	type OperationFinishedRecord,
	type OperationStartedRecord,
	type Session,
	uuidv7,
} from "@earendil-works/pi-agent-core";
import type { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { SessionError } from "./errors.ts";
import type { RunOutcome } from "./events.ts";

export const MAIN_LANE = "main";

export type KeaSession = Session<JsonlSessionMetadata>;

// pi's durable writes reject any explicit undefined ("Durable payload contains undefined"); structuredClone keeps
// them, JSON.stringify strips them — every Kea → pi session write must pass through this sanitize boundary.
export function sanitizeDurable<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export function sessionsRoot(cwd: string): string {
	return join(cwd, ".kea", "sessions");
}

export class SessionManager {
	readonly repo: JsonlSessionRepo;

	constructor(
		env: NodeExecutionEnv,
		readonly cwd: string,
	) {
		this.repo = new JsonlSessionRepo({ fs: env, sessionsRoot: sessionsRoot(cwd) });
	}

	async create(modelSpec: string): Promise<KeaSession> {
		return this.repo.create({ cwd: this.cwd, metadata: { app: "kea", model: modelSpec } });
	}

	async open(metadata: JsonlSessionMetadata): Promise<KeaSession> {
		try {
			return await this.repo.open(metadata);
		} catch (cause) {
			// surface the underlying validation error (e.g. "Invalid JSONL … non-consecutive seq") —
			// swallowing it leaves the user with an unactionable "failed to open session"
			throw new SessionError(
				`failed to open session ${metadata.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
				{ cause },
			);
		}
	}

	async list(): Promise<JsonlSessionMetadata[]> {
		const all = await this.repo.list({ cwd: this.cwd });
		return all.sort((a, b) => b.modifiedAt - a.modifiedAt);
	}

	async replay(session: KeaSession): Promise<AgentMessage[]> {
		const entries = (await session.view(MAIN_LANE).findEntriesOnBranch({})).reverse();
		// pi's standard context pruning (keep the last compaction + messages after it); message projection still uses Kea's own summary wording
		return defaultContextEntryTransform(entries).flatMap((entry): AgentMessage[] => {
			if (entry.type === "compaction") {
				return [SessionManager.summaryMessage(entry.summary, entry.timestamp), ...entry.retainedTail];
			}
			return entry.type === "message" ? [entry.message] : [];
		});
	}

	async append(session: KeaSession, messages: readonly AgentMessage[]): Promise<void> {
		const lane = session.view(MAIN_LANE);
		for (const message of messages) {
			await lane.appendMessage(sanitizeDurable(message));
		}
	}

	async startRun(session: KeaSession, prompt: readonly AgentMessage[]): Promise<string> {
		const runId = uuidv7();
		const leafId = await session.view(MAIN_LANE).getLeafId();
		const record: Omit<OperationStartedRecord, "seq" | "timestamp"> = {
			type: "operation_started",
			id: runId,
			lane: MAIN_LANE,
			sourceLeafId: leafId,
			intent: { kind: "run", originalPrompt: sanitizeDurable([...prompt]), initialMessages: [] },
		};
		await session.appendRecord(record);
		return runId;
	}

	async finishRun(session: KeaSession, runId: string, outcome: RunOutcome, error?: string): Promise<void> {
		const record: Omit<OperationFinishedRecord, "seq" | "timestamp"> = {
			type: "operation_finished",
			id: uuidv7(),
			lane: MAIN_LANE,
			runId,
			outcome,
		};
		if (error) record.error = { code: "run_failed", message: error };
		await session.appendRecord(sanitizeDurable(record));
	}

	async interruptedRuns(session: KeaSession): Promise<OperationStartedRecord[]> {
		return session.findOpenOperations(MAIN_LANE, { limit: 2 });
	}

	async entries(session: KeaSession): Promise<Entry[]> {
		return (await session.view(MAIN_LANE).findEntriesOnBranch({})).reverse();
	}

	async recordSystemPrompt(session: KeaSession, text: string): Promise<void> {
		const entry = { type: "custom" as const, id: uuidv7(), customType: "system_prompt", data: { text } };
		await session.appendEntry(sanitizeDurable(entry), MAIN_LANE);
	}

	// undefined for legacy sessions without a recorded prompt
	async readSystemPrompt(session: KeaSession): Promise<string | undefined> {
		const entries = await this.entries(session);
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry && entry.type === "custom" && entry.customType === "system_prompt") {
				const data = entry.data as { text?: unknown } | undefined;
				if (data && typeof data.text === "string") return data.text;
			}
		}
		return undefined;
	}

	static summaryMessage(summary: string, timestamp: number): AgentMessage {
		return {
			role: "user",
			content: [
				{
					type: "text",
					text: [
						"[Previous context summary]",
						"Treat the summary below as an accurate record of what already happened: do not redo work it reports as done, and build on it without restating it.",
						"Anything it reports as done is still unverified until you re-check it — for research work, re-verify durable claims (metric values, seed counts, evaluator/dataset versions, file paths) against the journal/files before relying on them.",
						summary,
					].join("\n"),
				},
			],
			timestamp,
		};
	}
}
