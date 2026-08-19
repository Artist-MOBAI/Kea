import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterAll, describe, expect, test } from "vitest";
import { createExecutionEnv } from "../src/env.ts";
import { MAIN_LANE, SessionManager, sanitizeDurable, sessionsRoot } from "../src/session.ts";

// pi's durable layer rejects any explicit undefined in the persisted payload; this suite pins Kea's
// sanitization boundary: dirty writes straight to pi are rejected, and succeed via SessionManager/sanitizeDurable.

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await Bun.$`rm -rf ${dir}`.quiet();
});

async function makeManager(): Promise<SessionManager> {
	const cwd = (await Bun.$`mktemp -d ${join(tmpdir(), "kea-durable-XXX")}`.quiet().text()).trim();
	dirs.push(cwd);
	return new SessionManager(createExecutionEnv(cwd).env, cwd);
}

const dirtyToolResult = (): AgentMessage =>
	structuredClone({
		role: "toolResult",
		toolCallId: "tc-1",
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		details: { exitCode: 0, signal: undefined },
		usage: undefined,
	}) as unknown as AgentMessage;

const dirtyUserMessage = (): AgentMessage =>
	structuredClone({
		role: "user",
		content: [{ type: "text", text: "hello" }],
		timestamp: 1,
		attachments: undefined,
	}) as unknown as AgentMessage;

describe("sanitizeDurable (persistence sanitization boundary)", () => {
	test("deeply strips explicit undefined, keeps normal values", () => {
		const cleaned = sanitizeDurable({
			a: 1,
			b: undefined,
			nested: { c: "x", d: undefined, arr: [1, undefined, { e: undefined, f: 2 }] },
		});
		expect(cleaned).toEqual({ a: 1, nested: { c: "x", arr: [1, null, { f: 2 }] } });
		expect("b" in cleaned).toBe(false);
		expect("d" in (cleaned.nested as Record<string, unknown>)).toBe(false);
	});
});

describe("pi validator presence proof (dirty payload direct write is always rejected)", () => {
	test("appendMessage direct write with explicit undefined → Durable payload contains undefined", async () => {
		const sessions = await makeManager();
		const session = await sessions.create("test/model");
		const lane = session.view(MAIN_LANE);
		await expect(lane.appendMessage(dirtyToolResult())).rejects.toThrow("Durable payload contains undefined");
	});

	test("appendEntry direct write of a compaction entry with explicit undefined → rejected as well", async () => {
		const sessions = await makeManager();
		const session = await sessions.create("test/model");
		const dirtyEntry = structuredClone({
			type: "compaction" as const,
			id: "c-1",
			summary: "s",
			retainedTail: [],
			tokensBefore: 1,
			details: { leaked: undefined },
		});
		await expect(session.appendEntry(dirtyEntry, MAIN_LANE)).rejects.toThrow("Durable payload contains undefined");
	});
});

describe("SessionManager sanitization boundary (dirty messages persist after crossing the boundary)", () => {
	test("append: toolResult with explicit undefined persists and the keys are stripped", async () => {
		const sessions = await makeManager();
		const session = await sessions.create("test/model");
		await sessions.append(session, [dirtyToolResult()]);

		const root = sessionsRoot(sessions.cwd);
		const [dir] = await readdir(root);
		const files = await readdir(join(root, dir as string));
		const jsonl = files.find((f) => f.endsWith(".jsonl")) as string;
		const lines = (await Bun.file(join(root, dir as string, jsonl)).text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const entry = lines.find((e) => e.type === "message" && e.message?.role === "toolResult");
		expect(entry).toBeDefined();
		expect(entry.message.details).toEqual({ exitCode: 0 });
		expect("usage" in entry.message).toBe(false);
		expect("signal" in entry.message.details).toBe(false);
	});

	test("startRun: prompt with explicit undefined also passes validation", async () => {
		const sessions = await makeManager();
		const session = await sessions.create("test/model");
		const runId = await sessions.startRun(session, [dirtyUserMessage()]);
		expect(runId).toBeTruthy();
		const open = await sessions.interruptedRuns(session);
		expect(open.map((r) => r.id)).toContain(runId);
	});

	test("appendEntry succeeds via sanitizeDurable (same pattern as compaction writes)", async () => {
		const sessions = await makeManager();
		const session = await sessions.create("test/model");
		const entry = sanitizeDurable(
			structuredClone({
				type: "compaction" as const,
				id: "c-2",
				summary: "s",
				retainedTail: [],
				tokensBefore: 1,
				details: { leaked: undefined },
			}),
		);
		await expect(session.appendEntry(entry, MAIN_LANE)).resolves.toBeDefined();
	});
});

describe("system prompt logging (model-visible ⟺ logged)", () => {
	test("recorded at creation, read back identical", async () => {
		const sessions = await makeManager();
		const session = await sessions.create("test/model");
		await sessions.recordSystemPrompt(session, "SYSTEM PROMPT v1");
		expect(await sessions.readSystemPrompt(session)).toBe("SYSTEM PROMPT v1");
	});

	test("sessions without a record read back undefined (legacy compat)", async () => {
		const sessions = await makeManager();
		const session = await sessions.create("test/model");
		expect(await sessions.readSystemPrompt(session)).toBeUndefined();
	});

	test("multiple records resolve to the last one", async () => {
		const sessions = await makeManager();
		const session = await sessions.create("test/model");
		await sessions.recordSystemPrompt(session, "v1");
		await sessions.recordSystemPrompt(session, "v2");
		expect(await sessions.readSystemPrompt(session)).toBe("v2");
	});
});
