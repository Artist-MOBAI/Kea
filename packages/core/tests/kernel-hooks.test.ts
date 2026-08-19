import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { KernelEvent } from "../src/events.ts";
import { HookBlockedError } from "../src/hooks.ts";
import { createKernel } from "../src/kernel.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

async function makeWorkdir(): Promise<string> {
	workdir = await mkdtemp(join(tmpdir(), "kea2-khooks-"));
	return workdir;
}

function setupFaux() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const fauxModel = faux.getModel();
	return { faux, models, spec: `${fauxModel.provider}/${fauxModel.id}` };
}

async function writeHooksConfig(cwd: string, log: string, events: string[]): Promise<void> {
	const hooks: Record<string, { command: string }[]> = {};
	for (const event of events) hooks[event] = [{ command: `cat >> '${log}'` }];
	await Bun.write(join(cwd, ".kea", "hooks.json"), JSON.stringify({ hooks }));
}

async function readLog(log: string): Promise<Array<Record<string, unknown>>> {
	if (!(await Bun.file(log).exists())) return [];
	const text = await Bun.file(log).text();
	const entries: Array<Record<string, unknown>> = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			entries.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			// partial line: the next re-read recovers
		}
	}
	return entries;
}

async function waitForLog(
	log: string,
	predicate: (entries: Array<Record<string, unknown>>) => boolean,
	timeoutMs = 10_000,
): Promise<Array<Record<string, unknown>>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const entries = await readLog(log);
		if (predicate(entries)) return entries;
		if (Date.now() > deadline) throw new Error(`timeout waiting for hook log: ${JSON.stringify(entries)}`);
		await Bun.sleep(50);
	}
}

const byEvent = (entries: Array<Record<string, unknown>>, name: string) =>
	entries.filter((e) => e.hook_event_name === name);

describe("kernel hooks integration (14-event surface)", () => {
	test("SessionStart fires on kernel create; Stop fires with outcome on run end", async () => {
		const cwd = await makeWorkdir();
		const log = join(cwd, "hook-log.jsonl");
		await writeHooksConfig(cwd, log, ["SessionStart", "Stop"]);
		const { faux, models, spec } = setupFaux();
		faux.setResponses([fauxAssistantMessage("hello")]);

		const kernel = await createKernel({ cwd, models, model: spec, trusted: true });
		await kernel.prompt("say hello");

		const entries = await waitForLog(log, (es) => byEvent(es, "Stop").length >= 1);
		const start = byEvent(entries, "SessionStart")[0];
		expect(start?.source).toBe("startup");
		expect(start?.session_id).toBe(kernel.sessionId);
		expect(start?.cwd).toBe(cwd);
		expect(typeof start?.model).toBe("string");
		const stop = byEvent(entries, "Stop")[0];
		expect(stop?.outcome).toBe("completed");
		expect(stop?.session_id).toBe(kernel.sessionId);
		await kernel.close();
	}, 20_000);

	test("UserPromptSubmit block: prompt() rejects with HookBlockedError, nothing persisted", async () => {
		const cwd = await makeWorkdir();
		await Bun.write(
			join(cwd, ".kea", "hooks.json"),
			JSON.stringify({
				hooks: { UserPromptSubmit: [{ command: "echo 'forbidden prompt' >&2; exit 2" }] },
			}),
		);
		const { faux, models, spec } = setupFaux();
		faux.setResponses([fauxAssistantMessage("should not run")]);

		const kernel = await createKernel({ cwd, models, model: spec, trusted: true });
		const seen: KernelEvent[] = [];
		kernel.events.subscribe((e) => seen.push(e));

		await expect(kernel.prompt("forbidden question")).rejects.toThrowError(HookBlockedError);
		await expect(kernel.prompt("another question")).rejects.toThrowError(/forbidden prompt/);
		expect((await kernel.sessions.replay(kernel.session)).length).toBe(0);
		expect(await kernel.sessions.interruptedRuns(kernel.session)).toHaveLength(0);
		expect(seen.some((e) => e.type === "run_start")).toBe(false);
		expect(faux.state.callCount).toBe(0);
		await kernel.close();
	}, 20_000);

	test("PreToolUse-blocked call: PostToolUse skipped (no phantom execution), tool_end event kept", async () => {
		const cwd = await makeWorkdir();
		const log = join(cwd, "hook-log.jsonl");
		// PreToolUse is a blocker (archive the envelope first, then exit 2); PostToolUse/Stop are pure loggers: different commands, so hand-write the config
		await Bun.write(
			join(cwd, ".kea", "hooks.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [{ command: `cat >> '${log}'; echo 'vetoed' >&2; exit 2`, matcher: "^bash$" }],
					PostToolUse: [{ command: `cat >> '${log}'` }],
					Stop: [{ command: `cat >> '${log}'` }],
				},
			}),
		);
		const { faux, models, spec } = setupFaux();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "touch should-not-run" })]),
			fauxAssistantMessage("done"),
		]);
		const kernel = await createKernel({ cwd, models, model: spec, permissionMode: "auto", trusted: true });
		const seen: KernelEvent[] = [];
		kernel.events.subscribe((e) => seen.push(e));

		await kernel.prompt("run the blocked command");

		// Stop spawns at the end of the run, after any PostToolUse: once Stop lands, the hook sequence is complete
		const entries = await waitForLog(
			log,
			(es) => byEvent(es, "PreToolUse").length >= 1 && byEvent(es, "Stop").length >= 1,
		);
		await Bun.sleep(100);
		expect(byEvent(entries, "PreToolUse")[0]?.tool_name).toBe("bash");
		expect(byEvent(entries, "PostToolUse")).toEqual([]);
		// The TUI channel is unaffected: the tool_end KernelEvent still fires (the blocked attempt is visible, flagged isError)
		const toolEnds = seen.filter((e): e is Extract<KernelEvent, { type: "tool_end" }> => e.type === "tool_end");
		expect(toolEnds.length).toBeGreaterThanOrEqual(1);
		expect(toolEnds[0]?.name).toBe("bash");
		expect(toolEnds[0]?.isError).toBe(true);
		await kernel.close();
	}, 20_000);

	test("PreCompact without PostCompact impossible: throw right after PreCompact still pairs", async () => {
		const cwd = await makeWorkdir();
		const log = join(cwd, "hook-log.jsonl");
		await writeHooksConfig(cwd, log, ["PreCompact", "PostCompact"]);
		const { faux, models, spec } = setupFaux();
		faux.setResponses([fauxAssistantMessage("short answer")]);
		const kernel = await createKernel({ cwd, models, model: spec, trusted: true });
		await kernel.prompt("hi");
		// corrupt the transcript so a throw lands right after PreCompact: PostCompact(applied false) must still pair
		kernel.agent.state.messages = [{ role: "assistant", content: 42 }] as never;
		const outcome = await kernel.compactNow();
		expect(outcome.applied).toBe(false);

		const entries = await waitForLog(
			log,
			(es) => byEvent(es, "PreCompact").length >= 1 && byEvent(es, "PostCompact").length >= 1,
		);
		expect(byEvent(entries, "PreCompact")).toHaveLength(1);
		const post = byEvent(entries, "PostCompact")[0];
		expect(post?.trigger).toBe("manual");
		expect(post?.applied).toBe(false);
		expect(typeof post?.error).toBe("string");
		await kernel.close();
	}, 20_000);

	test("idle abort does not fire Interrupt (programmatic idle aborts stay silent)", async () => {
		const cwd = await makeWorkdir();
		const log = join(cwd, "hook-log.jsonl");
		await writeHooksConfig(cwd, log, ["Interrupt"]);
		const { models, spec } = setupFaux();
		const kernel = await createKernel({ cwd, models, model: spec, trusted: true });
		// No run, non-streaming: abort is a programmatic no-op and must not emit a phantom Interrupt
		kernel.abort();
		await Bun.sleep(300);
		expect(await readLog(log)).toEqual([]);
		await kernel.close();
	}, 20_000);

	test("PreCompact/PostCompact fire around auto compaction (trigger auto, applied + tokens)", async () => {
		const cwd = await makeWorkdir();
		const log = join(cwd, "hook-log.jsonl");
		await writeHooksConfig(cwd, log, ["PreCompact", "PostCompact"]);
		const faux = fauxProvider({ models: [{ id: "faux-tiny", contextWindow: 1000 }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const m = faux.getModel("faux-tiny");
		if (!m) throw new Error("faux model missing");
		faux.setResponses([
			fauxAssistantMessage("x".repeat(4000)),
			fauxAssistantMessage("handoff summary"),
			fauxAssistantMessage("after compaction"),
		]);

		const settings = { enabled: true, reserveTokens: 800, keepRecentTokens: 1 };
		const kernel = await createKernel({
			cwd,
			models,
			model: `${m.provider}/${m.id}`,
			compactionSettings: settings,
			trusted: true,
		});
		kernel.events.subscribe((e) => {
			if (e.type === "compaction_applied") settings.enabled = false;
		});

		await kernel.prompt("please answer");

		const entries = await waitForLog(log, (es) => byEvent(es, "PostCompact").length >= 1);
		const pre = byEvent(entries, "PreCompact")[0];
		expect(pre?.trigger).toBe("auto");
		const post = byEvent(entries, "PostCompact")[0];
		expect(post?.trigger).toBe("auto");
		expect(post?.applied).toBe(true);
		expect(typeof post?.tokens_before).toBe("number");
		expect(typeof post?.tokens_after).toBe("number");
		await kernel.close();
	}, 30_000);

	test("compactNow fires PreCompact/PostCompact with trigger manual (nothing to compact → applied false)", async () => {
		const cwd = await makeWorkdir();
		const log = join(cwd, "hook-log.jsonl");
		await writeHooksConfig(cwd, log, ["PreCompact", "PostCompact"]);
		const { faux, models, spec } = setupFaux();
		faux.setResponses([fauxAssistantMessage("short answer")]);

		const kernel = await createKernel({ cwd, models, model: spec, trusted: true });
		await kernel.prompt("hi");
		const outcome = await kernel.compactNow();
		expect(outcome.applied).toBe(false);

		const entries = await waitForLog(log, (es) => byEvent(es, "PostCompact").length >= 1);
		expect(byEvent(entries, "PreCompact")[0]?.trigger).toBe("manual");
		const post = byEvent(entries, "PostCompact")[0];
		expect(post?.trigger).toBe("manual");
		expect(post?.applied).toBe(false);
		expect(typeof post?.error).toBe("string");
		await kernel.close();
	}, 20_000);

	test("Interrupt fires on abort with reason user_abort", async () => {
		const cwd = await makeWorkdir();
		const log = join(cwd, "hook-log.jsonl");
		await writeHooksConfig(cwd, log, ["Interrupt", "Stop"]);
		const { faux, models, spec } = setupFaux();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })]),
			fauxAssistantMessage("never reached"),
		]);
		const kernel = await createKernel({ cwd, models, model: spec, permissionMode: "auto", trusted: true });
		let abortScheduled = false;
		kernel.events.subscribe((e) => {
			if (e.type === "tool_start" && !abortScheduled) {
				abortScheduled = true;
				setTimeout(() => kernel.abort(), 150);
			}
		});

		await kernel.prompt("sleep a while");

		const entries = await waitForLog(
			log,
			(es) => byEvent(es, "Interrupt").length >= 1 && byEvent(es, "Stop").length >= 1,
		);
		expect(byEvent(entries, "Interrupt")[0]?.reason).toBe("user_abort");
		expect(byEvent(entries, "Stop")[0]?.outcome).toBe("aborted");
		await kernel.close();
	}, 30_000);

	test("session lifecycle: newSession fires SessionEnd(new)+SessionStart(new); dispose fires SessionEnd(exit) once", async () => {
		const cwd = await makeWorkdir();
		const log = join(cwd, "hook-log.jsonl");
		await writeHooksConfig(cwd, log, ["SessionStart", "SessionEnd"]);
		const { models, spec } = setupFaux();

		const kernel = await createKernel({ cwd, models, model: spec, trusted: true });
		const firstId = kernel.sessionId;
		const secondId = await kernel.newSession();

		const entries = await waitForLog(log, (es) => byEvent(es, "SessionStart").length >= 2);
		const end = byEvent(entries, "SessionEnd")[0];
		expect(end?.reason).toBe("new");
		expect(end?.session_id).toBe(firstId);
		const secondStart = byEvent(entries, "SessionStart")[1];
		expect(secondStart?.source).toBe("new");
		expect(secondStart?.session_id).toBe(secondId);

		// dispose: SessionEnd(exit) fires exactly once, executed by the time await returns; repeated dispose is idempotent
		await kernel.dispose();
		await kernel.dispose();
		const final = await readLog(log);
		const exits = byEvent(final, "SessionEnd").filter((e) => e.reason === "exit");
		expect(exits).toHaveLength(1);
		expect(exits[0]?.session_id).toBe(secondId);
	}, 20_000);

	test("UserPromptQueued fires when a prompt arrives while streaming (steer path)", async () => {
		const cwd = await makeWorkdir();
		const log = join(cwd, "hook-log.jsonl");
		await writeHooksConfig(cwd, log, ["UserPromptQueued"]);
		const { faux, models, spec } = setupFaux();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo step" })]),
			fauxAssistantMessage("done after steer"),
		]);
		const kernel = await createKernel({ cwd, models, model: spec, permissionMode: "auto", trusted: true });
		kernel.events.subscribe((e) => {
			if (e.type === "tool_end") kernel.steer("mid-run guidance");
		});
		await kernel.prompt("start the task");

		const entries = await waitForLog(log, (es) => byEvent(es, "UserPromptQueued").length >= 1);
		expect(byEvent(entries, "UserPromptQueued")[0]?.prompt).toBe("mid-run guidance");
		await kernel.close();
	}, 20_000);

	test("SubagentStart/SubagentStop fire around spawn_agent runs", async () => {
		const cwd = await makeWorkdir();
		const log = join(cwd, "hook-log.jsonl");
		await writeHooksConfig(cwd, log, ["SubagentStart", "SubagentStop"]);
		const { faux, models, spec } = setupFaux();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("spawn_agent", { task: "check the lattice constant" })]),
			// the subagent's own single-turn response (shares the same faux queue with the parent)
			fauxAssistantMessage("subagent handoff: 5.43 Å"),
			fauxAssistantMessage("done"),
		]);
		const kernel = await createKernel({ cwd, models, model: spec, permissionMode: "auto", trusted: true });

		await kernel.prompt("delegate the lookup");

		const entries = await waitForLog(log, (es) => byEvent(es, "SubagentStop").length >= 1);
		const start = byEvent(entries, "SubagentStart")[0];
		const stops = byEvent(entries, "SubagentStop");
		expect(typeof start?.subagent_id).toBe("string");
		// the normal path emits exactly one Stop (the finally safety net must not double-fire)
		expect(stops).toHaveLength(1);
		expect(stops[0]?.subagent_id).toBe(start?.subagent_id);
		expect(stops[0]?.outcome).toBe("completed");
		await kernel.close();
	}, 30_000);

	test("JobSubmitted/JobFinished fire for local backend jobs (watcher settle path)", async () => {
		const cwd = await makeWorkdir();
		const log = join(cwd, "hook-log.jsonl");
		await writeHooksConfig(cwd, log, ["JobSubmitted", "JobFinished"]);
		const { faux, models, spec } = setupFaux();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("run_experiment", { command: "echo kea-hook-job", backend: "local" })]),
			fauxAssistantMessage("submitted"),
		]);
		const kernel = await createKernel({ cwd, models, model: spec, permissionMode: "auto", trusted: true });
		// watcher must start before the job settles: otherwise the startup seed preloads the settled job into seen
		const watch = kernel.watchJobs(() => {});

		await kernel.prompt("run the experiment");

		const entries = await waitForLog(log, (es) => byEvent(es, "JobFinished").length >= 1, 20_000);
		const submitted = byEvent(entries, "JobSubmitted")[0];
		const finished = byEvent(entries, "JobFinished")[0];
		expect(typeof submitted?.job_id).toBe("string");
		expect(submitted?.backend).toBe("local");
		expect(finished?.job_id).toBe(submitted?.job_id);
		expect(finished?.backend).toBe("local");
		expect(finished?.outcome).toBe("completed");
		watch.stop();
		await kernel.close();
	}, 40_000);

	test("untrusted workdir: no hook fires at all (trust gating unchanged)", async () => {
		const cwd = await makeWorkdir();
		const log = join(cwd, "hook-log.jsonl");
		await writeHooksConfig(cwd, log, ["SessionStart", "UserPromptSubmit", "Stop"]);
		const { faux, models, spec } = setupFaux();
		faux.setResponses([fauxAssistantMessage("hello")]);

		const kernel = await createKernel({ cwd, models, model: spec });
		await kernel.prompt("say hello");
		await kernel.close();
		// fire-and-forget has no settle point: wait a beat for any potential process to land, then assert an empty log
		await Bun.sleep(300);
		expect(await readLog(log)).toEqual([]);
	}, 20_000);

	test("UserPromptSubmit output reminder: live order == replay order ([user, reminder]) (P2-E2)", async () => {
		const cwd = await makeWorkdir();
		await Bun.write(
			join(cwd, ".kea", "hooks.json"),
			JSON.stringify({ hooks: { UserPromptSubmit: [{ command: "echo 'project context note'" }] } }),
		);
		const { faux, models, spec } = setupFaux();
		faux.setResponses([fauxAssistantMessage("ack")]);

		const kernel = await createKernel({ cwd, models, model: spec, trusted: true });
		await kernel.prompt("do the thing");
		await kernel.agent.waitForIdle();

		const findIdx = (msgs: unknown[], needle: string): number =>
			msgs.findIndex(
				(m) => "role" in (m as object) && (m as { role: string }).role === "user" && JSON.stringify(m).includes(needle),
			);
		// live: pi pushes the prompt's user message at loop start, then drains steering — reminder must land AFTER
		const live = kernel.agent.state.messages;
		const liveUser = findIdx(live, "do the thing");
		const liveReminder = findIdx(live, "project context note");
		expect(liveUser).toBeGreaterThanOrEqual(0);
		expect(liveReminder).toBeGreaterThan(liveUser);

		// replay: ledger order must match the live order exactly (adjacency preserved, no reordering)
		const persisted = await kernel.sessions.replay(kernel.session);
		const pUser = findIdx(persisted, "do the thing");
		const pReminder = findIdx(persisted, "project context note");
		expect(pReminder).toBeGreaterThan(pUser);
		expect(pReminder - pUser).toBe(liveReminder - liveUser);
		await kernel.close();
	}, 20_000);
});

describe("Stop-hook loop guard (kimi parity: one hook-requested continuation per chain)", () => {
	test("always-blocking Stop: first block steers once, second does not steer (warn); fresh prompt resets", async () => {
		const cwd = await makeWorkdir();
		const log = join(cwd, "hook-log.jsonl");
		await Bun.write(
			join(cwd, ".kea", "hooks.json"),
			JSON.stringify({
				hooks: { Stop: [{ command: `cat >> '${log}'; echo 'continue requested' >&2; exit 2` }] },
			}),
		);
		const { faux, models, spec } = setupFaux();
		faux.setResponses([
			fauxAssistantMessage("r1"),
			fauxAssistantMessage("r2"),
			fauxAssistantMessage("r3"),
			fauxAssistantMessage("r4"),
		]);
		const kernel = await createKernel({ cwd, models, model: spec, trusted: true });
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await kernel.prompt("go");
			// the blocked Stop steered its single continuation (drained by the next run's loop start)
			expect(kernel.agent.hasQueuedMessages()).toBe(true);

			await kernel.prompt("continue");
			// same chain, Stop blocked again: no second steer, only the one-line loop warning
			expect(kernel.agent.hasQueuedMessages()).toBe(false);
			expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("Stop hook blocked again"))).toBe(true);

			await kernel.prompt("fresh");
			// no pending continuation → the guard budget resets and a block may steer again
			expect(kernel.agent.hasQueuedMessages()).toBe(true);
		} finally {
			warnSpy.mockRestore();
		}

		const entries = await waitForLog(log, (es) => byEvent(es, "Stop").length >= 3);
		const flags = byEvent(entries, "Stop").map((e) => e.stop_hook_active);
		expect(flags).toEqual([false, true, false]);
		await kernel.close();
	}, 30_000);

	test("session switch resets the continuation budget: the new session keeps its single hook continuation", async () => {
		const cwd = await makeWorkdir();
		const log = join(cwd, "hook-log.jsonl");
		await Bun.write(
			join(cwd, ".kea", "hooks.json"),
			JSON.stringify({
				hooks: { Stop: [{ command: `cat >> '${log}'; echo 'continue requested' >&2; exit 2` }] },
			}),
		);
		const { faux, models, spec } = setupFaux();
		faux.setResponses([fauxAssistantMessage("r1"), fauxAssistantMessage("r2")]);
		const kernel = await createKernel({ cwd, models, model: spec, trusted: true });
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await kernel.prompt("go");
			// the old session consumed its one hook continuation (steer queued for the next run)
			expect(kernel.agent.hasQueuedMessages()).toBe(true);

			await kernel.newSession();
			await kernel.prompt("fresh session");
			// the switch reset used/pending: the new session's Stop block steers instead of warn+drop
			expect(kernel.agent.hasQueuedMessages()).toBe(true);
			expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("Stop hook blocked again"))).toBe(false);
		} finally {
			warnSpy.mockRestore();
		}
		await kernel.close();
	}, 30_000);
});
