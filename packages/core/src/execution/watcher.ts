import { mapPooled } from "../subagent/pool.ts";
import { readMeta, scanJobIds } from "./ledger.ts";
import { type ExecutionBackend, isSettled, type JobState } from "./types.ts";

/** Minimum spacing between status() probes of the same remote job: every-tick probing means N ssh chains per 1.5s tick, and one dead host (20s timeouts) starves the rest of the tick. */
const REMOTE_PROBE_MIN_INTERVAL_MS = 10_000;

/** Probe lanes across distinct remote jobs: one dead host must not serialize-starve the other backends' probes. */
const REMOTE_PROBE_CONCURRENCY = 3;

export interface JobWatcherEvent {
	jobId: string;
	backend: string;
	state: JobState;
	label?: string;
}

/** Backend lookup for the watcher's active polls (structurally compatible with BackendRegistry). */
export interface JobWatcherBackends {
	get(name: string): ExecutionBackend | undefined;
}

export function createJobWatcher(
	cwd: string,
	onSettled: (event: JobWatcherEvent) => void,
	intervalMs = 1500,
	backends?: JobWatcherBackends,
	remoteProbeMinIntervalMs = REMOTE_PROBE_MIN_INTERVAL_MS,
): { start(): void; stop(): void } {
	const seen = new Set<string>();
	const lastProbe = new Map<string, number>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let ready = false;
	// stopped gates the whole tick: after stop(), any in-flight tick that completes must not fire onSettled again
	let stopped = false;
	// adjacent interval ticks (or the startup tick and an interval tick) can overlap, and overlap would double-fire onSettled
	let ticking = false;

	// startup replay protection: preload settled jobs into seen so later ticks don't re-fire onSettled for them;
	// on scan failure keep ready=false and retry on a later tick — proceeding with an empty seen would re-fire everything
	const seed = async (): Promise<boolean> => {
		const scan = await scanJobIds(cwd);
		if (stopped || !scan.ok) return false;
		for (const jobId of scan.ids) {
			if (stopped) return false;
			const meta = await readMeta(cwd, jobId);
			if (meta && isSettled(meta.state)) seen.add(jobId);
		}
		ready = true;
		return true;
	};

	const tick = async () => {
		if (stopped || ticking) return;
		ticking = true;
		try {
			if (!ready && !(await seed())) return;
			if (stopped) return;
			const scan = await scanJobIds(cwd);
			if (stopped) return;
			// scan failure ≠ no jobs: skip this round without pruning seen — wrongly clearing seen
			// would re-fire every settled job after IO recovers
			if (!scan.ok) return;
			// keep seen bounded: drop ids no longer in the list (if a job dir is cleaned up and the same id reappears, it can notify again)
			const idSet = new Set(scan.ids);
			for (const id of [...seen]) if (!idSet.has(id)) seen.delete(id);
			for (const id of [...lastProbe.keys()]) if (!idSet.has(id)) lastProbe.delete(id);
			const unsettled: Array<{ jobId: string; backend: string }> = [];
			for (const jobId of scan.ids) {
				// stop may happen between any awaits: re-check after each await, never fire again once stopped
				if (stopped) return;
				if (seen.has(jobId)) continue;
				const meta = await readMeta(cwd, jobId);
				if (stopped || !meta) continue;
				if (!isSettled(meta.state)) {
					unsettled.push({ jobId, backend: meta.backend });
					continue;
				}
				seen.add(jobId);
				lastProbe.delete(jobId);
				onSettled({ jobId, backend: meta.backend, state: meta.state, label: meta.label });
			}
			await pollUnsettled(unsettled);
		} finally {
			ticking = false;
		}
	};

	/**
	 * Active flow-back: remote backends (ssh/slurm/modal) surface settlement only through status()
	 * probes, and the human backend through result.json — without an active poll a finished remote
	 * job never lands in the local ledger, so settlement goes unnoticed until a restart reclaim.
	 * Probe each unsettled non-local job at most once per remoteProbeMinIntervalMs; status() settles
	 * the ledger itself, and the NEXT tick's settled scan fires onSettled through the regular
	 * seen-dedupe path — probing never fires, so it cannot double-fire.
	 */
	const pollUnsettled = async (jobs: Array<{ jobId: string; backend: string }>): Promise<void> => {
		if (!backends) return; // no registry wired: keep the legacy read-only behavior
		// per-job throttle: the tick interval bounds the scan, this bounds the remote probe rate;
		// filtering synchronously before the pool keeps the throttle decision atomic within a tick
		const due = jobs.filter(({ jobId }) => Date.now() - (lastProbe.get(jobId) ?? 0) >= remoteProbeMinIntervalMs);
		for (const { jobId } of due) lastProbe.set(jobId, Date.now());
		await mapPooled(due, REMOTE_PROBE_CONCURRENCY, async ({ jobId, backend: backendName }) => {
			if (stopped) return;
			const backend = backends.get(backendName);
			// local settles through its own in-process watch/poll — skip; unknown backends (e.g. removed config) have nothing to probe
			if (!backend || backend.name === "local") return;
			try {
				await backend.status(jobId);
			} catch {
				// remote unreachable / unknown job: skip this round, the next probe window retries
			}
		});
	};

	return {
		start() {
			if (timer) return;
			stopped = false;
			timer = setInterval(() => void tick().catch(() => {}), intervalMs);
			void tick().catch(() => {});
		},
		stop() {
			stopped = true;
			if (timer) clearInterval(timer);
			timer = undefined;
		},
	};
}
