import { listJobIds, readMeta, writeMeta } from "./ledger.ts";
import { SettleGate } from "./settle.ts";
import {
	type ExecutionBackend,
	isSettled,
	type JobResult,
	type JobSpec,
	type JobSpecInput,
	type JobState,
	type JobStatus,
} from "./types.ts";

/**
 * Shared skeleton for remote-process backends (ssh/slurm/modal): the job's real outcome lives outside
 * this process and surfaces only through status() probes. Settlement races run through the SettleGate
 * (first-claim + unsettled re-check on every write); cancel is probe-first, then settle-before-kill.
 */
export abstract class RemoteBackend implements ExecutionBackend {
	abstract readonly name: string;

	/** shared first-claim settlement discipline: a poll holds the claim for one probe; cancel waits it out via SettleGate.settle. */
	protected readonly gate = new SettleGate();

	constructor(protected readonly cwd: string) {}

	abstract submit(input: JobSpecInput): Promise<{ jobId: string }>;

	abstract result(jobId: string): Promise<JobResult>;

	async status(jobId: string): Promise<JobStatus> {
		const meta = await readMeta(this.cwd, jobId);
		if (!meta) throw new Error(`unknown job ${jobId}`);
		if (isSettled(meta.state) || !this.probeable(meta)) return meta;
		// first-claim discipline: while this probe holds the settlement mutex, concurrent callers observe the
		// current meta; a cancel arriving mid-probe waits it out (SettleGate.settle) instead of racing a write
		if (!this.gate.claim(jobId)) return meta;
		try {
			return await this.probeSettlement(jobId, meta);
		} finally {
			this.gate.release(jobId);
		}
	}

	/** whether status() has a probe to run for this unsettled job (default: a usable handle). */
	protected probeable(meta: JobStatus): boolean {
		return !!meta.handle;
	}

	/** one remote probe round while holding the settlement claim; settles the ledger when the real outcome has landed. */
	protected abstract probeSettlement(jobId: string, meta: JobStatus): Promise<JobStatus>;

	async cancel(jobId: string): Promise<void> {
		const meta = await readMeta(this.cwd, jobId);
		if (!meta) throw new Error(`unknown job ${jobId}`);
		// probe-first: a job whose outcome landed between the last probe and this cancel keeps its real
		// outcome — status() settles it; a probe failure falls through to settle-canceled below
		let probeFailed = false;
		try {
			if (isSettled((await this.status(jobId)).state)) return;
		} catch {
			probeFailed = true;
		}
		// settle-before-kill with first-claim: wait out an in-flight poll, never overwrite a terminal state.
		// never delete remote outcome artifacts — deleting exit.code would stick the task "running" forever
		await this.gate.settle(this.cwd, jobId, (fresh) => ({
			...fresh,
			state: "canceled",
			settledAt: Date.now(),
			reason: probeFailed
				? // the probe itself failed, so the remote outcome is unverified — the reason must say so
					{ kind: "user", message: "canceled while remote unreachable (outcome unverified)" }
				: { kind: "user", message: "canceled by user" },
		}));
		// kill through the post-settle fresh handle: the probe waited out above may have refreshed it
		// (modal SBID discovery) — killing through the pre-probe handle would leak the remote sandbox
		await this.killRemote(((await readMeta(this.cwd, jobId)) ?? meta).handle);
	}

	/** best-effort remote kill after the ledger is settled (settle-before-kill discipline). */
	protected abstract killRemote(handle: string | undefined): Promise<void>;

	async reclaimOrphans(): Promise<number> {
		// remote settlement surfaces only through status() probes (exit.code on disk): outside the watcher's
		// live polls a finished remote job never flows back. At startup sweep this backend's unsettled jobs
		// and settle locally whatever the remote reports settled.
		let reclaimed = 0;
		for (const jobId of await listJobIds(this.cwd)) {
			const meta = await readMeta(this.cwd, jobId);
			if (!meta || meta.backend !== this.name || isSettled(meta.state)) continue;
			try {
				reclaimed += await this.reclaimOne(jobId);
			} catch {
				// remote unreachable etc.: orphan settlement is best-effort
			}
		}
		return reclaimed;
	}

	/** default reclaim pass: one status() probe settles whatever already landed remotely. */
	protected async reclaimOne(jobId: string): Promise<number> {
		return isSettled((await this.status(jobId)).state) ? 1 : 0;
	}

	/** persist the initial job meta; on ledger failure run the backend cleanup — the remote job is already running with nobody to settle or kill it. */
	protected async recordJob(meta: JobStatus, cleanup: () => Promise<unknown>): Promise<void> {
		try {
			await writeMeta(this.cwd, meta);
		} catch (err) {
			await cleanup().catch(() => {});
			throw err;
		}
	}

	/** common initial meta for a submitted remote job (ssh/slurm/modal all persist this exact shape). */
	protected initialMeta(jobId: string, spec: JobSpec, state: JobState, handle: string): JobStatus {
		return {
			jobId,
			backend: this.name,
			state,
			label: spec.label,
			command: spec.command,
			submittedAt: Date.now(),
			handle,
			timeoutMs: spec.timeoutMs,
		};
	}

	/**
	 * Terminal settle from inside a probe (claim held): writes the patched terminal status and reports it
	 * on win; when someone settled in the claim gap, reports their terminal state instead (never overwritten).
	 */
	protected async settleTerminal(jobId: string, report: JobStatus): Promise<{ won: boolean; status: JobStatus }> {
		const won = await this.gate.writeSettled(this.cwd, jobId, (fresh) => ({
			...fresh,
			state: report.state,
			exitCode: report.exitCode,
			settledAt: report.settledAt,
			reason: report.reason,
			...(report.handle !== undefined ? { handle: report.handle } : {}),
		}));
		return { won, status: won ? report : ((await readMeta(this.cwd, jobId)) ?? report) };
	}
}
