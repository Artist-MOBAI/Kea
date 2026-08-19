import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { Kernel } from "@kea/core";
import { loadProgram, loadProgramStrict, type Program, saveMobaiIn, saveProgram } from "@kea/research";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { KeaTUI, sessionIdentityChanged } from "../src/tui/app.ts";
import { findOrphanMobai, sessionMobaiDir } from "../src/tui/mobai-dir.ts";
import { isMobaiPaused, loadQueue, pauseMobai, resumeMobai, saveQueue } from "../src/tui/mobai-lifecycle.ts";
import { makeTempDir, removeTempDir } from "./helpers/temp-dir.ts";

// The escalate window spans minutes of subagent work with the main agent idle — manual prompts,
// session switches, and Esc must all invalidate it. Driven through internals; the TUI never starts.
interface EscalationRequest {
	task: string;
	label?: string;
	signal?: AbortSignal;
}

interface KeaTUIInternals {
	tui: { stop(): void };
	transcript: { children: readonly Component[] };
	maybeAutoContinueProgram(): Promise<void>;
	advanceMobaiQueue(mobaiDir: string): Promise<void>;
	sendPrompt(text: string, opts?: { rearm?: boolean; display?: "bubble" | "system" }): Promise<boolean>;
	onSessionSwitched(): void;
	interruptEscalation(): boolean;
	autoContinueTimer: ReturnType<typeof setTimeout> | undefined;
	autoSettle: { roundsSinceProgress: number; analysisDue: boolean };
	programAutoRounds: number;
	programAutoRoundsBaseline: number;
	escalationAbort: AbortController | undefined;
	refreshFooter(): void;
	footerInFlight: boolean;
	mobaiActive: boolean;
	host: { onMobaiResumed?(): void };
	rebaseAutoRoundsNow(): Promise<number>;
	invalidateAutoContinue(): void;
	mobaiStateSnapshot: {
		status: string | undefined;
		kind: string | undefined;
		objective: string | undefined;
		paused: boolean;
	};
}

interface SubagentResultLike {
	id: string;
	profile: string;
	summary: string;
	turns: number;
	budgetExhausted: boolean;
	failed: boolean;
}

const SESSION_ID = "escalation-guard-test";

let workdir: string;
let originalCwd: string;
let originalHome: string | undefined;
let mobaiDir: string;

const subagentResult = (): SubagentResultLike => ({
	id: "worker",
	profile: "default",
	summary: "",
	turns: 0,
	budgetExhausted: false,
	failed: false,
});

function fixtureProgram(): Program {
	return {
		objective: "escalation guard fixture",
		criteria: [{ check: "command", description: "never passes", command: "false", expect_exit: 0 }],
		nodes: [
			{
				id: "root",
				kind: "theorem",
				title: "root",
				statement: "s",
				dependsOn: [],
				acceptance: { check: "command", description: "d", command: "true", expect_exit: 0 },
				status: "pending",
			},
		],
		journal: [],
		instruments: [
			{
				id: "i",
				version: 1,
				artifacts: [],
				recovers: [{ theorem: "T", check: { check: "command", description: "d", command: "true", expect_exit: 0 } }],
				novelty: { statement: "n", check: { check: "command", description: "d", command: "true", expect_exit: 0 } },
				status: "calibrated",
			},
		],
		barriers: [],
		status: "active",
		updatedAt: Date.now(),
	} as Program;
}

function seededJournal(rounds: number): Program["journal"] {
	return Array.from({ length: rounds }, (_, i) => ({
		round: i + 1,
		kind: "note" as const,
		description: `fixture round ${i + 1}`,
		evidence: "fixture",
		at: Date.now(),
	}));
}

function loopKernel(sessionId: string): Kernel {
	return {
		agent: { state: { isStreaming: false, messages: [] } },
		model: { provider: "test", id: "faux", contextWindow: 0 },
		sessionId,
		permissionMode: "manual",
		planMode: false,
		contextTokens: () => 0,
		contextWindow: 0,
		prompt: () => Promise.resolve(),
		reviewMobaiCommand: () => "approve" as const,
	} as never as Kernel;
}

// parks the app inside the epoch escalate await: subagents.run resolves only when the test releases
// it; rsp is pre-set to 6 so the round goes straight to epoch workers.
async function appInEpochWindow(): Promise<{
	app: KeaTUI;
	internals: KeaTUIInternals;
	spy: ReturnType<typeof vi.fn>;
	release: () => void;
	transcriptText: () => string;
}> {
	const spy = vi.fn();
	let releaseWorker: (() => void) | undefined;
	spy.mockImplementation(
		() =>
			new Promise<SubagentResultLike>((resolve) => {
				releaseWorker = () => resolve(subagentResult());
			}),
	);
	const kernel = {
		approvalHandler: undefined,
		agent: { state: { isStreaming: false, messages: [] } },
		model: { provider: "test", id: "faux", contextWindow: 0 },
		sessionId: SESSION_ID,
		permissionMode: "manual",
		planMode: false,
		contextTokens: () => 0,
		prompt: () => Promise.resolve(),
		reviewMobaiCommand: () => "approve" as const,
		subagents: { run: spy },
	} as never as Kernel;
	await saveProgram(mobaiDir, fixtureProgram());
	await resumeMobai(mobaiDir); // prior tests in this file may have left a paused marker
	const app = new KeaTUI(kernel);
	const internals = app as never as KeaTUIInternals;
	internals.tui.stop();
	internals.autoSettle.roundsSinceProgress = 6;
	return {
		app,
		internals,
		spy,
		release: () => releaseWorker?.(),
		transcriptText: () =>
			internals.transcript.children
				.flatMap((child) => child.render(120))
				.map((line) => stripTerminalSequences(line))
				.join("\n"),
	};
}

const waitFor = async (fn: () => void | Promise<void>, timeoutMs = 5_000): Promise<void> => {
	const startedAt = Date.now();
	for (;;) {
		try {
			await fn();
			return;
		} catch (err) {
			if (Date.now() - startedAt > timeoutMs) throw err;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
};

beforeAll(async () => {
	originalCwd = process.cwd();
	originalHome = process.env.HOME;
	workdir = await makeTempDir("kea2-escalation-guard-");
	process.chdir(workdir);
	process.env.HOME = workdir;
	mobaiDir = sessionMobaiDir(workdir, SESSION_ID);
});

afterAll(async () => {
	process.chdir(originalCwd);
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (workdir) await removeTempDir(workdir).catch(() => {});
});

describe("escalate await guard (generation token + Esc abort)", () => {
	test("manual prompt inside the await window: token change → settle discarded, no timer armed", async () => {
		const { internals, spy, release, transcriptText } = await appInEpochWindow();
		const loop = internals.maybeAutoContinueProgram();
		await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

		internals.sendPrompt("a manual prompt"); // rearm → generation bump
		release();
		await loop;

		expect(transcriptText()).toContain("auto-continue superseded");
		expect(internals.autoContinueTimer).toBeUndefined();
		// the epoch branch must not write its post-await settle state (rsp would climb to 1)
		expect(internals.autoSettle.roundsSinceProgress).toBe(0);
	}, 15_000);

	test("session switch inside the await window: same discard path, no old-session state leaks", async () => {
		const { internals, spy, release, transcriptText } = await appInEpochWindow();
		const loop = internals.maybeAutoContinueProgram();
		await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

		internals.onSessionSwitched(); // session_switched: timers cleared + generation bump
		release();
		await loop;

		expect(transcriptText()).toContain("auto-continue superseded");
		expect(internals.autoContinueTimer).toBeUndefined();
		expect(internals.autoSettle.roundsSinceProgress).toBe(0);
	}, 15_000);

	test("Esc interrupts escalation: worker gets the aborted signal, mobai paused, result discarded", async () => {
		const { internals, spy, release, transcriptText } = await appInEpochWindow();
		const loop = internals.maybeAutoContinueProgram();
		await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
		const request = spy.mock.calls[0]?.[0] as EscalationRequest;
		expect(request.signal).toBeInstanceOf(AbortSignal);

		expect(internals.interruptEscalation()).toBe(true);
		expect(request.signal?.aborted).toBe(true);
		await waitFor(async () => {
			if (!(await isMobaiPaused(mobaiDir))) throw new Error("mobai not paused yet");
		});

		release();
		await loop;
		expect(transcriptText()).toContain("auto-continue superseded");
		expect(internals.autoContinueTimer).toBeUndefined();
		// no window open anymore → a second Esc falls through to the normal ladder
		expect(internals.interruptEscalation()).toBe(false);
	}, 15_000);

	test("switch interrupts in-flight escalate window: abort fired + slot cleared (Esc falls through)", async () => {
		const { internals, spy, release } = await appInEpochWindow();
		const loop = internals.maybeAutoContinueProgram();
		await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
		const request = spy.mock.calls[0]?.[0] as EscalationRequest;

		internals.onSessionSwitched();

		expect(request.signal?.aborted).toBe(true);
		expect(internals.escalationAbort).toBeUndefined();
		// slot cleared → a post-switch Esc falls through instead of pausing the new session's mobai
		expect(internals.interruptEscalation()).toBe(false);

		release();
		await loop;
		expect(internals.autoContinueTimer).toBeUndefined();
	}, 15_000);
});

describe("mobai lifecycle on session switch (warm switch and cold resume are equal)", () => {
	test("warm-switch auto-pause: active program marked paused + snapshot synchronously reset to neutral", async () => {
		await saveProgram(mobaiDir, fixtureProgram());
		await resumeMobai(mobaiDir);
		const kernel = {
			agent: { state: { isStreaming: false, messages: [] } },
			model: { provider: "test", id: "faux", contextWindow: 0 },
			sessionId: SESSION_ID,
		} as never as Kernel;
		const app = new KeaTUI(kernel);
		const internals = app as never as KeaTUIInternals;
		internals.tui.stop();
		internals.mobaiStateSnapshot = { status: "active", kind: "program", objective: "old-session", paused: false };

		internals.onSessionSwitched();

		expect(internals.mobaiStateSnapshot).toEqual({
			status: undefined,
			kind: undefined,
			objective: undefined,
			paused: false,
		});
		await waitFor(async () => {
			if (!(await isMobaiPaused(mobaiDir))) throw new Error("mobai not paused by warm switch");
		});
	}, 15_000);

	test("switch during the main-path criteria check: superseded discard — no round stamp, no timer armed", async () => {
		const slow = fixtureProgram() as Program & { criteria: Array<{ command: string }> };
		for (const c of slow.criteria) c.command = "sleep 1";
		await saveProgram(mobaiDir, slow);
		await resumeMobai(mobaiDir);
		const kernel = {
			agent: { state: { isStreaming: false, messages: [] } },
			model: { provider: "test", id: "faux", contextWindow: 0 },
			sessionId: SESSION_ID,
			reviewMobaiCommand: () => "approve" as const,
		} as never as Kernel;
		const app = new KeaTUI(kernel);
		const internals = app as never as KeaTUIInternals;
		internals.tui.stop();
		internals.programAutoRounds = 0;

		const loop = internals.maybeAutoContinueProgram();
		await new Promise((resolve) => setTimeout(resolve, 200)); // the loop is inside checkProgram's `sleep 1`
		internals.onSessionSwitched(); // generation bump while the criteria command runs
		await loop;

		expect(internals.autoContinueTimer).toBeUndefined();
		expect(internals.programAutoRounds).toBe(0);
	}, 15_000);

	test("criteria all pass: settleComplete stamps programAutoRounds (headless parity, no +1 ghost)", async () => {
		const passing = fixtureProgram() as Program & { criteria: Array<{ command: string }> };
		for (const c of passing.criteria) c.command = "true";
		// journal is round-authoritative post-rebase: the head must actually sit at 25 on disk
		passing.journal = seededJournal(25);
		await saveProgram(mobaiDir, passing);
		await resumeMobai(mobaiDir);
		const kernel = {
			agent: { state: { isStreaming: false, messages: [] } },
			model: { provider: "test", id: "faux", contextWindow: 0 },
			sessionId: SESSION_ID,
			reviewMobaiCommand: () => "approve" as const,
		} as never as Kernel;
		const app = new KeaTUI(kernel);
		const internals = app as never as KeaTUIInternals;
		internals.tui.stop();
		internals.programAutoRounds = 25;

		await internals.maybeAutoContinueProgram();

		const program = await loadProgram(mobaiDir);
		expect(program?.status).toBe("complete");
		expect(program?.journal.at(-1)).toMatchObject({ kind: "program_completed", round: 25 });
	}, 15_000);

	test("auto-round cap is per-process: head 25 + cap 1 still runs one round (absolute would pause now)", async () => {
		const configPath = join(workdir, ".kea", "kea.toml");
		await Bun.write(configPath, "program_auto_max_rounds = 1\n");
		try {
			const { internals, spy, release, transcriptText } = await appInEpochWindow();
			// simulate the post-rebase state: journal head 25, baseline 25 (rounds added so far: 0)
			internals.programAutoRounds = 25;
			internals.programAutoRoundsBaseline = 25;
			const loop = internals.maybeAutoContinueProgram();
			await waitFor(() => expect(spy).toHaveBeenCalledTimes(1)); // the epoch round is NOT cap-blocked
			expect(transcriptText()).toContain("(1/1)");
			release();
			await loop;
			internals.onSessionSwitched(); // clear the armed follow-up timer before teardown
		} finally {
			await rm(configPath, { force: true });
		}
	}, 15_000);
});

describe("round rebase coverage (resume/boot entries never collide with historical rounds)", () => {
	test("resume ignition: journal head 5 → first stamped round is 6 (G1b regression)", async () => {
		await saveProgram(mobaiDir, { ...fixtureProgram(), journal: seededJournal(5) } as Program);
		await resumeMobai(mobaiDir); // prior tests may have left a paused marker
		const stamped: number[] = [];
		const app = new KeaTUI(loopKernel(SESSION_ID), { onProgramRound: (r) => stamped.push(r) });
		const internals = app as never as KeaTUIInternals;
		internals.tui.stop();
		internals.programAutoRounds = 0; // boot state: the fire-and-forget rebase never ran

		internals.host.onMobaiResumed?.();
		await waitFor(() => expect(stamped).toHaveLength(1));

		expect(stamped[0]).toBe(6); // journal-max + 1, not a colliding round 1
		internals.onSessionSwitched(); // clear the armed follow-up timer before teardown
	}, 15_000);

	test("maybeAutoContinueProgram entry awaits the rebase: journal head 25 → stamp 26 (G1b regression)", async () => {
		await saveProgram(mobaiDir, { ...fixtureProgram(), journal: seededJournal(25) } as Program);
		await resumeMobai(mobaiDir);
		const stamped: number[] = [];
		const app = new KeaTUI(loopKernel(SESSION_ID), { onProgramRound: (r) => stamped.push(r) });
		const internals = app as never as KeaTUIInternals;
		internals.tui.stop();
		internals.programAutoRounds = 0;

		await internals.maybeAutoContinueProgram();

		expect(stamped).toEqual([26]);
		internals.onSessionSwitched(); // clear the armed follow-up timer before teardown
	}, 15_000);

	test("generation changes inside the rebase window → write discarded (guard pin)", async () => {
		await saveProgram(mobaiDir, { ...fixtureProgram(), journal: seededJournal(25) } as Program);
		const app = new KeaTUI(loopKernel(SESSION_ID));
		const internals = app as never as KeaTUIInternals;
		internals.tui.stop();
		internals.programAutoRounds = 7;

		const rebase = internals.rebaseAutoRoundsNow();
		internals.invalidateAutoContinue(); // generation bump before the fs read resolves
		await rebase;

		expect(internals.programAutoRounds).toBe(7); // stale rebase discarded, not written
	}, 15_000);

	test("empty journal, first round completes → program_completed round ≥ 1 (G1a, no round-0 poison)", async () => {
		const passing = fixtureProgram() as Program & { criteria: Array<{ command: string }> };
		for (const c of passing.criteria) c.command = "true";
		await saveProgram(mobaiDir, passing);
		await resumeMobai(mobaiDir);
		const app = new KeaTUI(loopKernel(SESSION_ID));
		const internals = app as never as KeaTUIInternals;
		internals.tui.stop();
		internals.programAutoRounds = 0; // fresh formalization completed within its own round

		await internals.maybeAutoContinueProgram();

		const program = await loadProgram(mobaiDir);
		expect(program?.status).toBe("complete");
		expect(program?.journal.at(-1)).toMatchObject({ kind: "program_completed", round: 1 });
		// the settled ledger must survive a strict reload — round 0 would fail the journal schema
		expect(await loadProgramStrict(mobaiDir)).toBeDefined();
	}, 15_000);
});

describe("refreshFooter snapshot write guard (switch inside the await window writes no old-session state)", () => {
	const NEUTRAL = { status: undefined, kind: undefined, objective: undefined, paused: false };

	// reads 1-3 happen before the branch awaits resolve (entry, mobaiDir, post-loadProgram guard);
	// read 4 is the snapshot-write guard inside the branch — the simulated switch lands there
	function flippingKernel(first: string, second: string): Kernel {
		let reads = 0;
		return {
			agent: { state: { isStreaming: false, messages: [] } },
			model: { provider: "test", id: "faux", contextWindow: 0 },
			permissionMode: "manual",
			planMode: false,
			contextTokens: () => 0,
			contextWindow: 0,
			get sessionId() {
				reads++;
				return reads <= 3 ? first : second;
			},
		} as never as Kernel;
	}

	async function footerSettled(internals: KeaTUIInternals): Promise<void> {
		await waitFor(() => {
			if (internals.footerInFlight) throw new Error("footer refresh still in flight");
		});
	}

	test("program branch: switch in isMobaiPaused → snapshot can't overwrite neutral (G1c regression)", async () => {
		await saveProgram(sessionMobaiDir(workdir, "footer-a"), fixtureProgram());
		const app = new KeaTUI(flippingKernel("footer-a", "footer-b"));
		const internals = app as never as KeaTUIInternals;
		internals.tui.stop();
		internals.mobaiStateSnapshot = { ...NEUTRAL };
		internals.mobaiActive = false;

		internals.refreshFooter();
		await footerSettled(internals);

		expect(internals.mobaiStateSnapshot).toEqual(NEUTRAL);
		expect(internals.mobaiActive).toBe(false);
		await rm(sessionMobaiDir(workdir, "footer-a"), { recursive: true, force: true });
	}, 15_000);

	test("legacy branch: switch inside loadMobaiIn/isMobaiPaused → same guard (G1c regression)", async () => {
		await saveMobaiIn(sessionMobaiDir(workdir, "footer-legacy"), {
			objective: "legacy footer fixture",
			criteria: [{ check: "command", description: "d", command: "true", expect_exit: 0 }],
			status: "active",
			updatedAt: Date.now(),
		} as never);
		const app = new KeaTUI(flippingKernel("footer-legacy", "footer-b"));
		const internals = app as never as KeaTUIInternals;
		internals.tui.stop();
		internals.mobaiStateSnapshot = { ...NEUTRAL };
		internals.mobaiActive = false;

		internals.refreshFooter();
		await footerSettled(internals);

		expect(internals.mobaiStateSnapshot).toEqual(NEUTRAL);
		expect(internals.mobaiActive).toBe(false);
		await rm(sessionMobaiDir(workdir, "footer-legacy"), { recursive: true, force: true });
	}, 15_000);

	test("no switch: snapshot written normally (guard does not over-block)", async () => {
		await saveProgram(sessionMobaiDir(workdir, "footer-a"), fixtureProgram());
		const app = new KeaTUI(loopKernel("footer-a"));
		const internals = app as never as KeaTUIInternals;
		internals.tui.stop();

		internals.refreshFooter();
		await footerSettled(internals);

		expect(internals.mobaiStateSnapshot).toMatchObject({ status: "active", kind: "program", paused: false });
		expect(internals.mobaiActive).toBe(true);
		await rm(sessionMobaiDir(workdir, "footer-a"), { recursive: true, force: true });
	}, 15_000);
});

describe("advanceMobaiQueue (F3: queue continuation clears the ghost paused marker)", () => {
	test("completion's leftover paused marker is cleared before the head advances (no silent block)", async () => {
		const passing = fixtureProgram() as Program & { criteria: Array<{ command: string }> };
		for (const c of passing.criteria) c.command = "true";
		passing.status = "complete";
		await saveProgram(mobaiDir, passing);
		await pauseMobai(mobaiDir); // the completing objective's leftover marker
		await saveQueue(mobaiDir, ["queued objective"]);
		const prompts: string[] = [];
		const kernel = {
			agent: { state: { isStreaming: false, messages: [] } },
			model: { provider: "test", id: "faux", contextWindow: 0 },
			sessionId: SESSION_ID,
			permissionMode: "manual",
			planMode: false,
			contextTokens: () => 0,
			contextWindow: 0,
			prompt: (text: string) => {
				prompts.push(text);
				return Promise.resolve();
			},
		} as never as Kernel;
		const app = new KeaTUI(kernel);
		const internals = app as never as KeaTUIInternals;
		internals.tui.stop();

		await internals.advanceMobaiQueue(mobaiDir);

		expect(await isMobaiPaused(mobaiDir)).toBe(false);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("start_program");
		expect(await loadQueue(mobaiDir)).toEqual([]);
	}, 15_000);
});

describe("sessionIdentityChanged (pure predicate behind the refreshFooter cross-switch guard)", () => {
	test("entry differs from current → true (drop the write); same → false", () => {
		expect(sessionIdentityChanged("session-a", "session-b")).toBe(true);
		expect(sessionIdentityChanged("session-a", "session-a")).toBe(false);
	});
});

describe("findOrphanMobai (source of the orphan-mobai hint)", () => {
	test("newest active in another session wins; self/complete/empty skipped; paused flagged", async () => {
		await rm(sessionMobaiDir(workdir, SESSION_ID), { recursive: true, force: true }); // isolate from the lifecycle tests above
		expect(await findOrphanMobai(workdir, "current-session")).toBeUndefined();

		await saveProgram(sessionMobaiDir(workdir, "orphan-a"), fixtureProgram());
		let found = await findOrphanMobai(workdir, "current-session");
		expect(found?.sid).toBe("orphan-a");
		expect(found?.paused).toBe(false);
		expect(await findOrphanMobai(workdir, "orphan-a")).toBeUndefined();

		await saveProgram(sessionMobaiDir(workdir, "orphan-b"), fixtureProgram());
		await pauseMobai(sessionMobaiDir(workdir, "orphan-b"));
		found = await findOrphanMobai(workdir, "current-session");
		expect(found?.sid).toBe("orphan-b"); // ULID/lexicographic order: newest orphan wins
		expect(found?.paused).toBe(true);

		await saveProgram(sessionMobaiDir(workdir, "orphan-c"), { ...fixtureProgram(), status: "complete" } as Program);
		found = await findOrphanMobai(workdir, "current-session");
		expect(found?.sid).toBe("orphan-b"); // complete doesn't count
	}, 15_000);
});
