import { readMeta, writeMeta } from "./ledger.ts";
import { isSettled, type JobStatus } from "./types.ts";

/**
 * Settlement race discipline: a synchronous claim decides the winner among concurrent settlers
 * (cancel racing watch/timeout/reclaim/poll) with no read-await-write window; every write re-checks
 * the ledger so a settled job is never overwritten. The claim is a mutex around one attempt — always
 * released afterwards; correctness rests on the unsettled re-check.
 */
export class SettleGate {
	private readonly claimed = new Set<string>();

	/** Synchronous claim ahead of any await: the first among concurrent settlers wins. */
	claim(jobId: string): boolean {
		if (this.claimed.has(jobId)) return false;
		this.claimed.add(jobId);
		return true;
	}

	/** Release the claim without settling (still running / write failed) so later settlers can retry. */
	release(jobId: string): void {
		this.claimed.delete(jobId);
	}

	/**
	 * Write side of the discipline, run while holding the claim: re-read the ledger and write only
	 * when still unsettled. Always releases the claim afterwards. Returns whether this call performed
	 * the settlement.
	 */
	async writeSettled(cwd: string, jobId: string, makeSettled: (meta: JobStatus) => JobStatus): Promise<boolean> {
		try {
			const meta = await readMeta(cwd, jobId);
			if (!meta || isSettled(meta.state)) return false;
			await writeMeta(cwd, makeSettled(meta));
			return true;
		} catch {
			// the finally releases the claim so a later settler retries; one IO failure must not
			// stick the job "running" forever
			return false;
		} finally {
			this.release(jobId);
		}
	}

	/**
	 * Non-terminal ledger update (queued→running transitions, handle refresh) while holding the
	 * claim: same unsettled re-check, so it can never overwrite a state settled in the gap between
	 * the caller's read and this claim.
	 */
	async writeUnsettled(
		cwd: string,
		jobId: string,
		make: (meta: JobStatus) => JobStatus,
	): Promise<JobStatus | undefined> {
		const meta = await readMeta(cwd, jobId);
		if (!meta || isSettled(meta.state)) return meta;
		const next = make(meta);
		await writeMeta(cwd, next);
		return next;
	}

	/**
	 * Settle from outside the poll path (user cancel / watch timeout / reclaim): an in-flight status
	 * probe may hold the claim for up to one remote roundtrip, so wait it out (bounded) instead of
	 * dropping the settlement. Returns whether this call performed the settlement.
	 */
	async settle(
		cwd: string,
		jobId: string,
		makeSettled: (meta: JobStatus) => JobStatus,
		waitMs = 70_000,
	): Promise<boolean> {
		const deadline = Date.now() + waitMs;
		for (;;) {
			const meta = await readMeta(cwd, jobId).catch(() => undefined);
			if (!meta || isSettled(meta.state)) return false;
			if (this.claim(jobId)) return await this.writeSettled(cwd, jobId, makeSettled);
			if (Date.now() > deadline) return false;
			await Bun.sleep(50);
		}
	}
}
