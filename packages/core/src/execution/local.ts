import { mkdirSync } from "node:fs";
import { type ExecutionEnv, uuidv7 } from "@earendil-works/pi-agent-core";
import type { Subprocess } from "bun";
import { JOB_DEFAULT_TIMEOUT_MS } from "../timeouts.ts";
import { jobDir, readLog, readMeta, stderrPath, stdoutPath, writeMeta } from "./ledger.ts";
import { SettleGate } from "./settle.ts";
import {
	type ExecutionBackend,
	isSettled,
	type JobResult,
	type JobSpecInput,
	JobSpecSchema,
	type JobState,
	type JobStatus,
	truncateLog,
} from "./types.ts";

const ORPHAN_POLL_MS = 500;

interface ActiveJob {
	/** orphans re-attached after restart have no Subprocess object, only a pid (from meta.handle). */
	proc?: Subprocess;
	pid: number;
	timer?: ReturnType<typeof setTimeout>;
	poll?: ReturnType<typeof setInterval>;
}

export class LocalBackend implements ExecutionBackend {
	readonly name = "local";
	private active = new Map<string, ActiveJob>();
	/** shared first-claim settlement discipline (SettleGate): the sync claim decides the winner among concurrent settlers. */
	private readonly gate = new SettleGate();

	constructor(
		private readonly env: ExecutionEnv,
		private readonly cwd: string,
	) {}

	async submit(input: JobSpecInput): Promise<{ jobId: string }> {
		const spec = JobSpecSchema.parse(input);
		const jobId = uuidv7();
		mkdirSync(jobDir(this.cwd, jobId), { recursive: true });
		// pi 0.84.1 contract deviation: the ExecutionEnv interface exposes no shell field; here we read NodeExecutionEnv's private
		// shellPath (falling back to /bin/bash when missing). Re-check on pi upgrades whether a public API now exists.
		const shellPath = (this.env as { shellPath?: string }).shellPath ?? "/bin/bash";

		// detached:true → the child setsid() into its own process-group leader (pgid === pid).
		// cancel/timeout kills the whole group via negative pid, so python/training children don't survive after being reparented.
		const proc = Bun.spawn([shellPath, "-c", spec.command], {
			cwd: this.cwd,
			env: { ...process.env, ...(spec.env ?? {}) },
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});

		const logsFlushed = Promise.all([
			streamToFile(proc.stdout, stdoutPath(this.cwd, jobId)),
			streamToFile(proc.stderr, stderrPath(this.cwd, jobId)),
		]);

		try {
			await writeMeta(this.cwd, {
				jobId,
				backend: this.name,
				state: "running",
				label: spec.label,
				command: spec.command,
				submittedAt: Date.now(),
				handle: String(proc.pid),
				// persist the timeout: after a crash-restart reclaimOrphans re-arms by the original timeout instead of hard-coding a new value
				timeoutMs: spec.timeoutMs,
			});
		} catch (err) {
			// ledger write failed: the just-spawned process has nobody to settle/kill — kill the process group immediately (detached pgid === pid), never leave an orphan
			try {
				process.kill(-proc.pid);
			} catch {
				try {
					proc.kill();
				} catch {
					// ESRCH = already exited
				}
			}
			throw err;
		}

		const timer = setTimeout(() => {
			void this.timeoutJob(jobId, `exceeded ${spec.timeoutMs}ms`);
		}, spec.timeoutMs);

		this.active.set(jobId, { proc, pid: proc.pid, timer });
		void this.watch(jobId, proc, timer, logsFlushed);
		return { jobId };
	}

	private async watch(
		jobId: string,
		proc: Subprocess,
		timer: ReturnType<typeof setTimeout>,
		logsFlushed: Promise<unknown>,
	): Promise<void> {
		const exitCode = await proc.exited;
		// streamToFile swallows all IO errors internally and never rejects, so no .catch needed
		await logsFlushed;
		clearTimeout(timer);
		this.active.delete(jobId);
		const state = exitCode === 0 ? "completed" : "failed";
		const reason: JobStatus["reason"] = {
			kind: exitCode === 0 ? "system" : "executor",
			message: exitCode === 0 ? undefined : `exit code ${exitCode}`,
		};
		const won = await this.settle(jobId, state, exitCode, reason);
		// transient ledger IO failure: the process has exited and active is deleted, but without retry meta would be stuck running forever — move into settlement retry polling
		if (!won) this.retrySettle(jobId, state, exitCode, reason);
	}

	/** settlement retry for an exited process: poll until settle succeeds or the ledger is already terminal (never stuck running). */
	private retrySettle(jobId: string, state: JobState, exitCode: number | undefined, reason: JobStatus["reason"]): void {
		const poll = setInterval(() => {
			void (async () => {
				const meta = await readMeta(this.cwd, jobId).catch(() => undefined);
				if (meta && isSettled(meta.state)) {
					clearInterval(poll);
					return;
				}
				const won = await this.settle(jobId, state, exitCode, reason);
				if (won) {
					clearInterval(poll);
					this.teardown(jobId);
				}
			})();
		}, ORPHAN_POLL_MS);
	}

	async status(jobId: string): Promise<JobStatus> {
		const meta = await readMeta(this.cwd, jobId);
		if (!meta) throw new Error(`unknown job ${jobId}`);
		return meta;
	}

	async result(jobId: string): Promise<JobResult> {
		const meta = await this.status(jobId);
		return {
			...meta,
			stdout: truncateLog(await readLog(stdoutPath(this.cwd, jobId))),
			stderr: truncateLog(await readLog(stderrPath(this.cwd, jobId))),
		};
	}

	async cancel(jobId: string): Promise<void> {
		const entry = this.active.get(jobId);
		if (entry) {
			// a process that has ALREADY exited is about to be settled completed/failed by watch(); cancel must not
			// race it and flip a real outcome to canceled — return and let the real settlement win (first-claim is sync)
			if (entry.proc && entry.proc.exitCode !== null) return;
			// settle-before-kill: settle the ledger first, only kill the process group and clear the timer on success.
			// if settlement fails (ledger IO error) but we kill anyway, meta would be stuck "running" forever — don't kill, leave it for a later settler to retry
			const won = await this.settle(jobId, "canceled", undefined, { kind: "user", message: "canceled by user" });
			if (won) this.teardown(jobId);
			return;
		}
		const meta = await readMeta(this.cwd, jobId);
		if (!meta) return;
		const won = await this.settle(jobId, "canceled", undefined, { kind: "user", message: "canceled by user" });
		if (!won) return;
		// orphan after crash-restart: meta unsettled but the process may still be alive — settle before killing the process (settle-before-kill).
		// PID-reuse risk: handle stores only the pid, so after a restart we can't reliably tell the original process from a reused pid
		// (start-time verification needs platform tooling, not done) — therefore kill a single pid, not the process group,
		// minimizing the blast radius of killing an unrelated process; the cost is the orphan's descendants may survive (known limitation).
		const pid = Number(meta.handle);
		if (processAlive(pid)) {
			try {
				process.kill(pid);
			} catch {
				// ESRCH = process just died; EPERM etc. also need no handling
			}
		}
	}

	async reclaimOrphans(): Promise<number> {
		let reclaimed = 0;
		const glob = new Bun.Glob("*/meta.json");
		try {
			for await (const file of glob.scan({ cwd: jobDir(this.cwd, ""), onlyFiles: true })) {
				// glob guarantees file is "<jobId>/meta.json", so the first segment is a non-empty string
				const jobId = file.split("/")[0] as string;
				try {
					const meta = await readMeta(this.cwd, jobId);
					if (!meta || isSettled(meta.state)) continue;
					const pid = Number(meta.handle);
					if (!processAlive(pid)) {
						await this.settle(jobId, "preempted", undefined, {
							kind: "preempted",
							message: "process not alive after restart",
						});
						reclaimed += 1;
						continue;
					}
					// living orphan: re-arm timeout + liveness polling, otherwise it would never settle or time out
					this.reattachOrphan(jobId, pid, meta);
					reclaimed += 1;
				} catch {
					// a single bad meta does not block reclaiming the rest
				}
			}
		} catch {
			// scan-level failure such as missing jobs dir: nothing to reclaim
		}
		return reclaimed;
	}

	activeCount(): number {
		return this.active.size;
	}

	async cancelAll(): Promise<void> {
		await Promise.all([...this.active.keys()].map((id) => this.cancel(id)));
	}

	private reattachOrphan(jobId: string, pid: number, meta: JobStatus): void {
		const timeoutMs = meta.timeoutMs ?? JOB_DEFAULT_TIMEOUT_MS;
		const remaining = Math.max(1000, timeoutMs - (Date.now() - meta.submittedAt));
		const timer = setTimeout(() => {
			void this.timeoutJob(jobId, `exceeded ${timeoutMs}ms (re-attached after restart)`);
		}, remaining);
		const poll = setInterval(() => {
			if (processAlive(pid)) return;
			// process exited but we are not its parent, so the exit code is unavailable — fail-closed, settle failed.
			// on settlement failure (ledger IO error) don't tear down: keep the poll so the next round retries, and the job doesn't get stuck "running"
			void this.settle(jobId, "failed", undefined, {
				kind: "system",
				message: "orphaned process exited while detached (exit code lost)",
			}).then((won) => {
				if (won) this.teardown(jobId);
			});
		}, ORPHAN_POLL_MS);
		this.active.set(jobId, { pid, timer, poll });
	}

	/** timeout settlement (settle-before-kill): write the ledger first, only kill the process and tear down on success (don't kill on write failure, keep the retry window). */
	private async timeoutJob(jobId: string, message: string): Promise<void> {
		const won = await this.settle(jobId, "failed", undefined, { kind: "timeout", message });
		if (won) this.teardown(jobId);
	}

	/** kill the process, stop timers, remove from the active map (idempotent). */
	private teardown(jobId: string): void {
		const entry = this.active.get(jobId);
		if (!entry) return;
		killJobProcess(entry);
		if (entry.timer) clearTimeout(entry.timer);
		if (entry.poll) clearInterval(entry.poll);
		this.active.delete(jobId);
	}

	/**
	 * Single settlement entry, first settlement wins (discipline lives in SettleGate). Returns
	 * whether this call performed the settlement — callers use it to decide follow-up (e.g.
	 * whether an orphan should still be killed).
	 */
	private async settle(
		jobId: string,
		state: JobState,
		exitCode: number | undefined,
		reason: JobStatus["reason"],
	): Promise<boolean> {
		return this.gate.settle(this.cwd, jobId, (meta) => ({
			...meta,
			state,
			exitCode,
			reason,
			settledAt: Date.now(),
		}));
	}
}

/**
 * Kill a job process: jobs submitted by this process (with a Subprocess) start detached with pgid === pid,
 * so prefer killing the whole process group via negative pid, collecting grandchildren (python/training processes) too;
 * on group-kill failure or for orphans (only a pid, unknown lineage) fall back to a single pid — better to miss descendants than kill unrelated processes.
 */
function killJobProcess(entry: ActiveJob): void {
	if (entry.proc) {
		try {
			process.kill(-entry.pid);
			return;
		} catch {
			// process group no longer exists etc.: fall back to single kill
		}
	}
	try {
		process.kill(entry.pid);
	} catch {
		// ESRCH = already dead
	}
}

/** Write a child process output stream to a log file; all IO errors are swallowed internally, the returned Promise never rejects. */
async function streamToFile(stream: ReadableStream<Uint8Array>, path: string): Promise<void> {
	const writer = Bun.file(path).writer();
	try {
		for await (const chunk of stream) {
			writer.write(chunk);
		}
	} catch {
	} finally {
		try {
			await writer.end();
		} catch {}
	}
}

/** pid liveness probe; NaN/negative/no-permission/already-dead all count as not alive. Reused by the modal backend. */
export function processAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
