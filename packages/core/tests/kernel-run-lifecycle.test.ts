import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { KernelEvent } from "../src/events.ts";
import { createKernel } from "../src/kernel.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

async function makeWorkdir(): Promise<string> {
	workdir = await mkdtemp(join(tmpdir(), "kea2-runlc-"));
	return workdir;
}

function setupFaux() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const fauxModel = faux.getModel();
	return { faux, models, spec: `${fauxModel.provider}/${fauxModel.id}` };
}

const runStarts = (seen: KernelEvent[]) => seen.filter((e) => e.type === "run_start");
const runEnds = (seen: KernelEvent[]) =>
	seen.filter((e): e is Extract<KernelEvent, { type: "run_end" }> => e.type === "run_end");

describe("run lifecycle (widened scope: prompt + compaction/continue chain = one run)", () => {
	test("normal prompt: exactly one run_start/run_end pair, ledger balanced", async () => {
		const cwd = await makeWorkdir();
		const { faux, models, spec } = setupFaux();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo lifecycle-ok" })]),
			fauxAssistantMessage("done"),
		]);
		const kernel = await createKernel({ cwd, models, model: spec, permissionMode: "auto" });
		const seen: KernelEvent[] = [];
		kernel.events.subscribe((e) => seen.push(e));

		await kernel.prompt("run echo");

		expect(runStarts(seen)).toHaveLength(1);
		const ends = runEnds(seen);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.outcome).toBe("completed");
		expect(ends[0]?.runId).toBe(runStarts(seen)[0]?.runId);
		expect(seen[seen.length - 1]?.type).toBe("run_end");
		expect(await kernel.sessions.interruptedRuns(kernel.session)).toHaveLength(0);
		await kernel.close();
	}, 20_000);

	test("abort path: still exactly one run_end with outcome aborted, ledger balanced", async () => {
		const cwd = await makeWorkdir();
		const { faux, models, spec } = setupFaux();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })]),
			fauxAssistantMessage("never reached"),
		]);
		const kernel = await createKernel({ cwd, models, model: spec, permissionMode: "auto" });
		const seen: KernelEvent[] = [];
		let abortScheduled = false;
		kernel.events.subscribe((e) => {
			seen.push(e);
			// abort after the tool truly starts (deterministic timing; abort while idle is a no-op)
			if (e.type === "tool_start" && !abortScheduled) {
				abortScheduled = true;
				setTimeout(() => kernel.abort(), 150);
			}
		});

		await kernel.prompt("sleep a while");

		expect(runStarts(seen)).toHaveLength(1);
		const ends = runEnds(seen);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.outcome).toBe("aborted");
		expect(await kernel.sessions.interruptedRuns(kernel.session)).toHaveLength(0);
		await kernel.close();
	}, 30_000);

	test("compaction-continue chain: one run throughout, run_end emitted once at the end of the chain", async () => {
		const cwd = await makeWorkdir();
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
		});
		kernel.events.subscribe((e) => {
			if (e.type === "compaction_applied") settings.enabled = false;
		});
		let injected = false;
		kernel.agent.subscribe(async (event) => {
			if (event.type === "turn_end" && !injected) {
				injected = true;
				await kernel.sessions.append(kernel.session, [
					{ role: "user", content: [{ type: "text", text: "steer" }], timestamp: Date.now() },
				]);
			}
		});

		const seen: KernelEvent[] = [];
		kernel.events.subscribe((e) => seen.push(e));

		await kernel.prompt("please answer");

		expect(faux.state.callCount).toBe(3);
		expect(runStarts(seen)).toHaveLength(1);
		const ends = runEnds(seen);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.outcome).toBe("completed");
		const appliedIdx = seen.findIndex((e) => e.type === "compaction_applied");
		const endIdx = seen.findIndex((e) => e.type === "run_end");
		expect(appliedIdx).toBeGreaterThanOrEqual(0);
		expect(endIdx).toBeGreaterThan(appliedIdx);
		expect(seen[seen.length - 1]?.type).toBe("run_end");
		expect(await kernel.sessions.interruptedRuns(kernel.session)).toHaveLength(0);
		await kernel.close();
	}, 30_000);

	test("context overflow 400 → emergency compaction → injected continue → same-run recovery (kimi)", async () => {
		const cwd = await makeWorkdir();
		const faux = fauxProvider({ models: [{ id: "faux-tiny", contextWindow: 1000 }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const m = faux.getModel("faux-tiny");
		if (!m) throw new Error("faux model missing");
		faux.setResponses([
			// the oversized request fails with the REAL production 400 wording (recovery parses it)
			fauxAssistantMessage("x", {
				stopReason: "error",
				errorMessage:
					'400: {"message":"This model\'s maximum context length is 1048576 tokens. However, you requested 1050492 tokens (1050491 in the messages, 1 in the completion). Please reduce the length of the messages or completion.","type":"invalid_request_error"}',
			}),
			fauxAssistantMessage("handoff summary"),
			fauxAssistantMessage("recovered answer"),
		]);

		const settings = { enabled: true, reserveTokens: 800, keepRecentTokens: 1 };
		const kernel = await createKernel({
			cwd,
			models,
			model: `${m.provider}/${m.id}`,
			compactionSettings: settings,
		});
		// the 1000-token test window stays "full" even after compaction (envelope alone exceeds it):
		// stop the ordinary post-turn auto-compaction once the EMERGENCY one applied, isolating the recovery path
		kernel.events.subscribe((e) => {
			if (e.type === "compaction_applied") settings.enabled = false;
		});
		const seen: KernelEvent[] = [];
		kernel.events.subscribe((e) => seen.push(e));

		await kernel.prompt("please answer");

		expect(faux.state.callCount).toBe(3);
		expect(runStarts(seen)).toHaveLength(1);
		const ends = runEnds(seen);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.outcome).toBe("completed");
		expect(seen.some((e) => e.type === "compaction_applied")).toBe(true);
		// observed-window self-calibration never RAISES the declared window
		expect(kernel.contextWindow).toBeLessThanOrEqual(1000);
		faux.appendResponses([fauxAssistantMessage("second ok")]);
		await kernel.prompt("again");
		const allEnds = runEnds(seen);
		expect(allEnds[allEnds.length - 1]?.outcome).toBe("completed");
		await kernel.close();
	}, 30_000);

	test("K1: ledger finishRun write failure does not deadlock settlement — run_end/Stop still emitted", async () => {
		const cwd = await makeWorkdir();
		const { faux, models, spec } = setupFaux();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo ledger-fault" })]),
			fauxAssistantMessage("done"),
		]);
		const kernel = await createKernel({ cwd, models, model: spec, permissionMode: "auto" });
		const seen: KernelEvent[] = [];
		kernel.events.subscribe((e) => seen.push(e));
		const finishSpy = vi.spyOn(kernel.sessions, "finishRun").mockRejectedValue(new Error("ledger write failed"));
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await kernel.prompt("run with faulty ledger");

		const ends = runEnds(seen);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.outcome).toBe("completed");
		expect(seen[seen.length - 1]?.type).toBe("run_end");
		expect(finishSpy).toHaveBeenCalled();
		expect(errSpy).toHaveBeenCalled();
		finishSpy.mockRestore();
		errSpy.mockRestore();
		await kernel.close();
	}, 30_000);

	test("K2: prompt() re-entry rejected — second prompt throws while a run is in progress", async () => {
		const cwd = await makeWorkdir();
		const { faux, models, spec } = setupFaux();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.2" })]),
			fauxAssistantMessage("done"),
		]);
		const kernel = await createKernel({ cwd, models, model: spec, permissionMode: "auto" });
		let secondRejected: Promise<unknown> | undefined;
		kernel.events.subscribe((e) => {
			if (e.type === "run_start" && !secondRejected) {
				secondRejected = kernel.prompt("reentrant").then(
					() => "resolved",
					(error) => error,
				);
			}
		});

		await kernel.prompt("first run");

		const err = await secondRejected;
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("already in progress");
		await kernel.close();
	}, 30_000);

	test("K3: compaction summary can be aborted by the run — signal reaches the summary LLM call", async () => {
		const cwd = await makeWorkdir();
		const faux = fauxProvider({ models: [{ id: "faux-tiny", contextWindow: 1000 }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const m = faux.getModel("faux-tiny");
		if (!m) throw new Error("faux model missing");

		let summarySignal: AbortSignal | undefined;
		faux.setResponses([
			fauxAssistantMessage("x".repeat(4000)),
			(_ctx, opts) => {
				summarySignal = opts?.signal;
				return new Promise((resolve) => {
					const timer = setInterval(() => {
						if (opts?.signal?.aborted) {
							clearInterval(timer);
							resolve(fauxAssistantMessage("late summary"));
						}
					}, 5);
				});
			},
		]);

		const settings = { enabled: true, reserveTokens: 800, keepRecentTokens: 1 };
		const kernel = await createKernel({
			cwd,
			models,
			model: `${m.provider}/${m.id}`,
			compactionSettings: settings,
		});
		const seen: KernelEvent[] = [];
		kernel.events.subscribe((e) => seen.push(e));

		const promptDone = kernel.prompt("please answer");
		// wait for the summary call to actually reach the provider (signal connected), then trigger abort via newSession → settleActiveRun
		const deadline = Date.now() + 10_000;
		while (summarySignal === undefined && Date.now() < deadline) {
			await Bun.sleep(10);
		}
		expect(summarySignal).toBeDefined();
		expect(summarySignal?.aborted).toBe(false);
		await kernel.newSession();
		await promptDone;

		expect(summarySignal?.aborted).toBe(true);
		expect(seen.some((e) => e.type === "compaction_failed")).toBe(true);
		expect(runEnds(seen)).toHaveLength(1);
		await kernel.close();
	}, 30_000);

	test("K4: kernel.abort() mid-summary — the run must still settle (compaction_failed + one run_end)", async () => {
		const cwd = await makeWorkdir();
		const faux = fauxProvider({ models: [{ id: "faux-tiny", contextWindow: 1000 }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const m = faux.getModel("faux-tiny");
		if (!m) throw new Error("faux model missing");

		let summarySignal: AbortSignal | undefined;
		faux.setResponses([
			fauxAssistantMessage("x".repeat(4000)),
			(_ctx, opts) => {
				summarySignal = opts?.signal;
				return new Promise((resolve) => {
					const timer = setInterval(() => {
						if (opts?.signal?.aborted) {
							clearInterval(timer);
							resolve(fauxAssistantMessage("late summary"));
						}
					}, 5);
				});
			},
		]);

		const settings = { enabled: true, reserveTokens: 800, keepRecentTokens: 1 };
		const kernel = await createKernel({
			cwd,
			models,
			model: `${m.provider}/${m.id}`,
			compactionSettings: settings,
		});
		const seen: KernelEvent[] = [];
		kernel.events.subscribe((e) => seen.push(e));

		const promptDone = kernel.prompt("please answer");
		const deadline = Date.now() + 10_000;
		while (summarySignal === undefined && Date.now() < deadline) {
			await Bun.sleep(10);
		}
		expect(summarySignal).toBeDefined();

		kernel.abort();
		const settled = await Promise.race([
			promptDone.then(() => true),
			new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
		]);
		if (!settled) {
			// Unsettled: unhang via newSession (settleActiveRun) for cleanup, then report the defect
			await kernel.newSession();
			await promptDone;
		}
		expect(
			settled,
			"kernel.abort() did not interrupt the in-flight compaction summary call — the run hangs (abort signal never reaches runAbort)",
		).toBe(true);
		expect(seen.some((e) => e.type === "compaction_failed")).toBe(true);
		expect(runEnds(seen)).toHaveLength(1);
		expect(await kernel.sessions.interruptedRuns(kernel.session)).toHaveLength(0);
		await kernel.close();
	}, 30_000);

	test("K5: summary LLM fails without abort — compaction_failed + exactly one run_end, ledger balanced", async () => {
		const cwd = await makeWorkdir();
		const faux = fauxProvider({ models: [{ id: "faux-tiny", contextWindow: 1000 }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const m = faux.getModel("faux-tiny");
		if (!m) throw new Error("faux model missing");

		faux.setResponses([
			fauxAssistantMessage("x".repeat(4000)),
			() => {
				throw new Error("summary provider exploded");
			},
		]);

		const settings = { enabled: true, reserveTokens: 800, keepRecentTokens: 1 };
		const kernel = await createKernel({
			cwd,
			models,
			model: `${m.provider}/${m.id}`,
			compactionSettings: settings,
		});
		const seen: KernelEvent[] = [];
		kernel.events.subscribe((e) => seen.push(e));

		await kernel.prompt("please answer");

		const failed = seen.filter((e) => e.type === "compaction_failed");
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({ type: "compaction_failed" });
		const ends = runEnds(seen);
		expect(ends).toHaveLength(1);
		expect(seen[seen.length - 1]?.type).toBe("run_end");
		expect(await kernel.sessions.interruptedRuns(kernel.session)).toHaveLength(0);
		await kernel.close();
	}, 30_000);

	test("Esc during compaction chain: run_end settles aborted (completed would trigger auto-continue)", async () => {
		const cwd = await makeWorkdir();
		const faux = fauxProvider({ models: [{ id: "faux-tiny", contextWindow: 1000 }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const m = faux.getModel("faux-tiny");
		if (!m) throw new Error("faux model missing");
		faux.setResponses([fauxAssistantMessage("x".repeat(4000))]);
		// gate the compaction summary call: it never resolves on its own — only the abort signal can break it.
		// Object.create keeps the prototype (a plain spread would drop the class methods resolveModel needs)
		const gated = Object.assign(Object.create(Object.getPrototypeOf(models)), models, {
			completeSimple: () => new Promise(() => {}),
		}) as typeof models;
		const settings = { enabled: true, reserveTokens: 800, keepRecentTokens: 1 };
		const kernel = await createKernel({
			cwd,
			models: gated,
			model: `${m.provider}/${m.id}`,
			compactionSettings: settings,
		});
		const seen: KernelEvent[] = [];
		kernel.events.subscribe((e) => {
			seen.push(e);
			if (e.type === "compaction_started") setTimeout(() => kernel.abort(), 30);
		});

		await kernel.prompt("please answer");

		const ends = runEnds(seen);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.outcome).toBe("aborted");
		expect(await kernel.sessions.interruptedRuns(kernel.session)).toHaveLength(0);
		await kernel.close();
	}, 30_000);

	test("compaction replays reminders before continue (kimi: first post-compaction request carries state)", async () => {
		const cwd = await makeWorkdir();
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
		});
		kernel.events.subscribe((e) => {
			if (e.type === "compaction_applied") settings.enabled = false;
		});
		let reannounce = false;
		kernel.injections.register({
			variant: "test_reannounce",
			evaluate: () => (reannounce ? "POST-COMPACTION-STATE-MARKER" : undefined),
			onCompacted: () => {
				reannounce = true;
			},
		});
		// mirror the compaction-chain test: a trailing user message in the ledger keeps the retained tail
		// resumable, so the pending loop actually calls continue() (the drain point for the re-announced reminder)
		let seeded = false;
		kernel.agent.subscribe(async (event) => {
			if (event.type === "turn_end" && !seeded) {
				seeded = true;
				await kernel.sessions.append(kernel.session, [
					{ role: "user", content: [{ type: "text", text: "steer" }], timestamp: Date.now() },
				]);
			}
		});

		await kernel.prompt("please answer");

		// the re-announced reminder must be in the transcript, not queued for a later turn
		const delivered = kernel.agent.state.messages.some((msg) => {
			if (!("role" in msg) || msg.role !== "user") return false;
			const content = msg.content;
			if (!Array.isArray(content)) return false;
			return content.some((b) => b.type === "text" && b.text.includes("POST-COMPACTION-STATE-MARKER"));
		});
		expect(delivered).toBe(true);
		await kernel.close();
	}, 30_000);

	test("appendSystemReminder: appends a wrapped message at idle, enters context, next run unaffected", async () => {
		const cwd = await makeWorkdir();
		const { faux, models, spec } = setupFaux();
		faux.setResponses([fauxAssistantMessage("ack")]);
		const kernel = await createKernel({ cwd, models, model: spec, permissionMode: "auto" });
		await kernel.appendSystemReminder("The user cancelled the current mobai. Ignore earlier mobai reminders.");
		const msgs = kernel.agent.state.messages;
		const last = msgs[msgs.length - 1];
		expect(last && "role" in last && last.role === "user").toBe(true);
		const text = JSON.stringify((last as { content?: unknown }).content ?? "");
		expect(text).toContain("<system-reminder>");
		expect(text).toContain("cancelled the current mobai");

		const seen: KernelEvent[] = [];
		kernel.events.subscribe((e) => seen.push(e));
		await kernel.prompt("next task");
		const ends = runEnds(seen);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.outcome).toBe("completed");
		await kernel.close();
	}, 20_000);
});
