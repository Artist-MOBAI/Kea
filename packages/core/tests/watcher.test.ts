import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createExecutionEnv } from "../src/env.ts";
import { jobDir, readMeta, scanJobIds, writeMeta } from "../src/execution/ledger.ts";
import { LocalBackend } from "../src/execution/local.ts";
import type { ExecutionBackend } from "../src/execution/types.ts";
import { createJobWatcher, type JobWatcherEvent } from "../src/execution/watcher.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

describe("scanJobIds (E3: a failed scan ≠ genuinely empty)", () => {
	test("ENOENT = genuinely empty; other scan errors surface as ok:false", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-watch-"));
		expect(await scanJobIds(workdir)).toEqual({ ids: [], ok: true });
		await writeMeta(workdir, {
			jobId: "scan-1",
			backend: "local",
			state: "completed",
			command: "true",
			submittedAt: Date.now(),
			settledAt: Date.now(),
			exitCode: 0,
		});
		expect(await scanJobIds(workdir)).toEqual({ ids: ["scan-1"], ok: true });

		const jobs = join(workdir, ".kea", "jobs");
		await chmod(jobs, 0o000);
		try {
			const blocked = await scanJobIds(workdir);
			if (!blocked.ok) expect(blocked).toEqual({ ids: [], ok: false }); // if the env (e.g. root) doesn't block, skip
		} finally {
			await chmod(jobs, 0o755);
		}
	});
});

describe("JobWatcher (M4)", () => {
	test("fires exactly once per settled job", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-watch-"));
		const { env } = await createExecutionEnv(workdir);
		const backend = new LocalBackend(env, workdir);

		const events: JobWatcherEvent[] = [];
		const watcher = createJobWatcher(workdir, (e) => events.push(e), 50);
		watcher.start();
		// let the startup seed finish (seen preloads historically settled jobs) before submitting a new job
		await Bun.sleep(200);
		const { jobId } = await backend.submit({ command: "echo fast" });
		await Bun.sleep(2000);
		watcher.stop();

		const mine = events.filter((e) => e.jobId === jobId);
		expect(mine.length).toBe(1);
		expect(mine[0]?.state).toBe("completed");
	}, 15_000);

	test("start does not re-fire historically settled jobs", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-watch-"));
		const settledStates = ["completed", "failed", "canceled", "preempted"] as const;
		for (const [i, state] of settledStates.entries()) {
			await writeMeta(workdir, {
				jobId: `old-${i}`,
				backend: "local",
				state,
				command: "true",
				submittedAt: Date.now() - 60_000,
				settledAt: Date.now() - 30_000,
			});
		}

		const events: JobWatcherEvent[] = [];
		const watcher = createJobWatcher(workdir, (e) => events.push(e), 50);
		watcher.start();
		await Bun.sleep(500);
		watcher.stop();

		expect(events.filter((e) => e.jobId.startsWith("old-"))).toEqual([]);
	}, 15_000);

	test("awaiting_human job settling after start still fires", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-watch-"));
		await writeMeta(workdir, {
			jobId: "human-1",
			backend: "local",
			state: "awaiting_human",
			command: "true",
			submittedAt: Date.now(),
		});

		const events: JobWatcherEvent[] = [];
		const watcher = createJobWatcher(workdir, (e) => events.push(e), 50);
		watcher.start();
		// awaiting_human is unsettled, so the startup seed must not preload it
		await Bun.sleep(200);
		expect(events.filter((e) => e.jobId === "human-1")).toEqual([]);
		await writeMeta(workdir, {
			jobId: "human-1",
			backend: "local",
			state: "completed",
			command: "true",
			submittedAt: Date.now(),
			settledAt: Date.now(),
			exitCode: 0,
		});
		await Bun.sleep(500);
		watcher.stop();

		const mine = events.filter((e) => e.jobId === "human-1");
		expect(mine.length).toBe(1);
		expect(mine[0]?.state).toBe("completed");
	}, 15_000);

	test("overlapping ticks never double-fire onSettled", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-watch-"));
		// a large settled backlog + a tiny interval force adjacent ticks to overlap
		for (let i = 0; i < 300; i++) {
			await writeMeta(workdir, {
				jobId: `bulk-${i}`,
				backend: "local",
				state: "completed",
				command: "true",
				submittedAt: Date.now(),
				settledAt: Date.now(),
				exitCode: 0,
			});
		}
		await writeMeta(workdir, {
			jobId: "late-1",
			backend: "local",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
		});

		const events: JobWatcherEvent[] = [];
		const watcher = createJobWatcher(workdir, (e) => events.push(e), 1);
		watcher.start();
		await Bun.sleep(300);
		// settle a new job inside the tick window: both overlapping ticks read it settled
		await writeMeta(workdir, {
			jobId: "late-1",
			backend: "local",
			state: "failed",
			command: "true",
			submittedAt: Date.now(),
			settledAt: Date.now(),
			exitCode: 1,
		});
		await Bun.sleep(500);
		watcher.stop();

		const counts = new Map<string, number>();
		for (const e of events) counts.set(e.jobId, (counts.get(e.jobId) ?? 0) + 1);
		for (const [jobId, n] of counts) expect(n, `job ${jobId} fired ${n} times`).toBe(1);
		expect(counts.get("late-1")).toBe(1);
	}, 20_000);

	test("scan failure skips prune: no duplicate onSettled after I/O recovers (E3)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-watch-"));
		const events: JobWatcherEvent[] = [];
		const watcher = createJobWatcher(workdir, (e) => events.push(e), 30);
		watcher.start();
		await Bun.sleep(200);
		await writeMeta(workdir, {
			jobId: "scanfail-1",
			backend: "local",
			state: "completed",
			command: "true",
			submittedAt: Date.now(),
			settledAt: Date.now(),
			exitCode: 0,
		});
		await Bun.sleep(300);
		expect(events.filter((e) => e.jobId === "scanfail-1").length).toBe(1);

		// IO fault: the scan fails — pruning "seen" now would re-fire every settled job after recovery
		const jobs = join(workdir, ".kea", "jobs");
		await chmod(jobs, 0o000);
		try {
			const blocked = await scanJobIds(workdir);
			if (blocked.ok) return; // if the env doesn't block reads (e.g. root) → can't reproduce, skip
			await Bun.sleep(300);
		} finally {
			await chmod(jobs, 0o755);
		}
		await Bun.sleep(300);
		watcher.stop();

		expect(events.filter((e) => e.jobId === "scanfail-1").length).toBe(1);
	}, 20_000);

	test("seen stays bounded: removed job dirs are pruned and re-fire if they reappear", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-watch-"));
		const events: JobWatcherEvent[] = [];
		const watcher = createJobWatcher(workdir, (e) => events.push(e), 50);
		watcher.start();
		await Bun.sleep(200);

		await writeMeta(workdir, {
			jobId: "prune-1",
			backend: "local",
			state: "completed",
			command: "true",
			submittedAt: Date.now(),
			settledAt: Date.now(),
			exitCode: 0,
		});
		await Bun.sleep(400);
		expect(events.filter((e) => e.jobId === "prune-1").length).toBe(1);

		// after the dir is removed, seen prunes; the same id re-settling can notify again
		await rm(jobDir(workdir, "prune-1"), { recursive: true, force: true });
		await Bun.sleep(400);
		await writeMeta(workdir, {
			jobId: "prune-1",
			backend: "local",
			state: "failed",
			command: "true",
			submittedAt: Date.now(),
			settledAt: Date.now(),
			exitCode: 1,
		});
		await Bun.sleep(400);
		watcher.stop();

		expect(events.filter((e) => e.jobId === "prune-1").length).toBe(2);
	}, 20_000);
});

describe("JobWatcher active flow-back (E1: watcher polls backend.status)", () => {
	/** fake remote backend whose status() settles the ledger itself, exactly like ssh/slurm/modal do */
	function fakeRemote(cwd: string, failFirst = 0) {
		let calls = 0;
		const backend = {
			name: "ssh:fake",
			async status(jobId: string) {
				calls += 1;
				if (calls <= failFirst) throw new Error("remote unreachable");
				const meta = await readMeta(cwd, jobId);
				if (!meta) throw new Error(`unknown job ${jobId}`);
				const settled = { ...meta, state: "completed" as const, exitCode: 0, settledAt: Date.now() };
				await writeMeta(cwd, settled);
				return settled;
			},
		};
		return { backend: backend as unknown as ExecutionBackend, calls: () => calls };
	}

	test("running remote job settles via watcher probes: meta updated and onSettled fires exactly once", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-watch-"));
		await writeMeta(workdir, {
			jobId: "remote-1",
			backend: "ssh:fake",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "/remote/remote-1",
		});
		const { backend, calls } = fakeRemote(workdir);
		const events: JobWatcherEvent[] = [];
		const watcher = createJobWatcher(workdir, (e) => events.push(e), 50, { get: () => backend });
		watcher.start();
		await Bun.sleep(1000);
		const callsAfterSettle = calls();
		watcher.stop();
		await Bun.sleep(300);

		const mine = events.filter((e) => e.jobId === "remote-1");
		expect(mine.length).toBe(1);
		expect(mine[0]?.backend).toBe("ssh:fake");
		expect(mine[0]?.state).toBe("completed");
		expect((await readMeta(workdir, "remote-1"))?.state).toBe("completed");
		// settled jobs are never probed again (probe throttling + seen dedupe)
		expect(calls()).toBe(callsAfterSettle);
	}, 15_000);

	test("backend status() throwing does not crash the watcher; the next tick retries and settles", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-watch-"));
		await writeMeta(workdir, {
			jobId: "remote-err",
			backend: "ssh:fake",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "/remote/remote-err",
		});
		const { backend, calls } = fakeRemote(workdir, 2);
		const events: JobWatcherEvent[] = [];
		// probe interval 0: this test exercises per-tick retry semantics, not the throttle (covered separately below)
		const watcher = createJobWatcher(workdir, (e) => events.push(e), 50, { get: () => backend }, 0);
		watcher.start();
		await Bun.sleep(1500);
		watcher.stop();

		expect(calls()).toBeGreaterThanOrEqual(3); // two failed probes retried, third settled
		const mine = events.filter((e) => e.jobId === "remote-err");
		expect(mine.length).toBe(1);
		expect((await readMeta(workdir, "remote-err"))?.state).toBe("completed");
	}, 15_000);

	test("local jobs are never probed; pre-settled jobs are neither re-probed nor re-fired", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-watch-"));
		await writeMeta(workdir, {
			jobId: "local-1",
			backend: "local",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
		});
		await writeMeta(workdir, {
			jobId: "old-remote",
			backend: "ssh:fake",
			state: "completed",
			command: "true",
			submittedAt: Date.now() - 60_000,
			settledAt: Date.now() - 30_000,
			exitCode: 0,
		});
		await writeMeta(workdir, {
			jobId: "live-remote",
			backend: "ssh:fake",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "/remote/live-remote",
		});
		const probed: string[] = [];
		const localSpy = {
			name: "local",
			async status(jobId: string) {
				probed.push(`local:${jobId}`);
				throw new Error("local jobs must not be probed by the watcher");
			},
		};
		const remote = {
			name: "ssh:fake",
			async status(jobId: string) {
				probed.push(`remote:${jobId}`);
				throw new Error("remote unreachable");
			},
		};
		const events: JobWatcherEvent[] = [];
		const watcher = createJobWatcher(workdir, (e) => events.push(e), 50, {
			get: (name) =>
				name === "local" ? (localSpy as unknown as ExecutionBackend) : (remote as unknown as ExecutionBackend),
		});
		watcher.start();
		await Bun.sleep(600);
		watcher.stop();

		expect(events).toEqual([]);
		expect((await readMeta(workdir, "local-1"))?.state).toBe("running");
		expect(probed.length).toBeGreaterThan(0);
		expect(probed.every((p) => p === "remote:live-remote")).toBe(true);
	}, 15_000);

	test("no backends wired: legacy read-only behavior (meta settled externally still notifies)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-watch-"));
		await writeMeta(workdir, {
			jobId: "legacy-1",
			backend: "ssh:fake",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "/remote/legacy-1",
		});
		const events: JobWatcherEvent[] = [];
		const watcher = createJobWatcher(workdir, (e) => events.push(e), 50);
		watcher.start();
		await Bun.sleep(200);
		await writeMeta(workdir, {
			jobId: "legacy-1",
			backend: "ssh:fake",
			state: "failed",
			command: "true",
			submittedAt: Date.now(),
			settledAt: Date.now(),
			exitCode: 1,
		});
		await Bun.sleep(500);
		watcher.stop();
		const mine = events.filter((e) => e.jobId === "legacy-1");
		expect(mine.length).toBe(1);
		expect(mine[0]?.state).toBe("failed");
	}, 15_000);

	test("per-job probe throttle: remote jobs are not re-probed on every tick (J5)", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-watch-"));
		await writeMeta(workdir, {
			jobId: "throttle-1",
			backend: "ssh:fake",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "/remote/throttle-1",
		});
		let calls = 0;
		const backend = {
			name: "ssh:fake",
			// never settles: the job stays unsettled, so only the throttle bounds the probe count
			async status(jobId: string) {
				calls += 1;
				const meta = await readMeta(workdir, jobId);
				if (!meta) throw new Error(`unknown job ${jobId}`);
				return meta;
			},
		};
		const watcher = createJobWatcher(workdir, () => {}, 50, { get: () => backend as unknown as ExecutionBackend }, 300);
		watcher.start();
		await Bun.sleep(1000);
		watcher.stop();
		// 1s at 50ms ticks = ~20 ticks: without the throttle every tick would probe (~20 calls);
		// with a 300ms per-job minimum the count must stay in the single digits but keep retrying
		expect(calls).toBeGreaterThanOrEqual(2);
		expect(calls).toBeLessThanOrEqual(8);
	}, 15_000);
});
