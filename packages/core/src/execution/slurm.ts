import { uuidv7 } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { SshBackend, SshConfigSchema, shellQuote } from "./ssh.ts";
import { type JobSpec, type JobSpecInput, JobSpecSchema, type JobStatus } from "./types.ts";

export const SlurmConfigSchema = SshConfigSchema.extend({
	partition: z.string().optional(),
	account: z.string().optional(),
	memoryMb: z.number().int().positive().optional(),
	extraSbatch: z.array(z.string()).optional(),
});
export type SlurmConfig = z.infer<typeof SlurmConfigSchema>;

/** COMPLETED but exit.code not on disk (runner async write/NFS lag): settle failed after N consecutive observations, never stuck "running" */
export const SLURM_COMPLETED_GRACE_SCANS = 5;

export function buildSbatchScript(spec: JobSpec, jobId: string, remoteDir: string, config: SlurmConfig): string {
	const timeoutS = Math.ceil(spec.timeoutMs / 1000);
	const hours = Math.ceil(timeoutS / 3600);
	const lines = [
		"#!/bin/bash",
		`#SBATCH --job-name=kea-${jobId}`,
		`#SBATCH --output=${remoteDir}/stdout.log`,
		`#SBATCH --error=${remoteDir}/stderr.log`,
		`#SBATCH --time=${hours}:00:00`,
	];
	if (config.partition) lines.push(`#SBATCH --partition=${config.partition}`);
	if (config.account) lines.push(`#SBATCH --account=${config.account}`);
	const memory = spec.resources?.memoryMb ?? config.memoryMb;
	if (memory) lines.push(`#SBATCH --mem=${memory}`);
	if (spec.resources?.cpus) lines.push(`#SBATCH --cpus-per-task=${spec.resources.cpus}`);
	if (spec.resources?.gpus) lines.push(`#SBATCH --gpus=${spec.resources.gpus}`);
	for (const extra of config.extraSbatch ?? []) lines.push(`#SBATCH ${extra}`);
	lines.push(`cd '${remoteDir}' || exit 97`);
	lines.push(`bash -c ${shellQuote(spec.command)}`, "echo $? > exit.code");
	return lines.join("\n");
}

export function parseSbatchId(stdout: string): number | undefined {
	const match = /Submitted batch job (\d+)/.exec(stdout);
	return match?.[1] ? Number(match[1]) : undefined;
}

/** handle format `<slurmJobId>:<remoteDir>`; remoteDir may itself contain colons — split only at the first colon. */
export function parseSlurmHandle(handle: string | undefined): { slurmId?: number; remoteDir: string } {
	if (!handle) return { remoteDir: "" };
	const sep = handle.indexOf(":");
	if (sep === -1) {
		const id = Number(handle);
		return { slurmId: Number.isFinite(id) ? id : undefined, remoteDir: "" };
	}
	const id = Number(handle.slice(0, sep));
	return { slurmId: Number.isFinite(id) ? id : undefined, remoteDir: handle.slice(sep + 1) };
}

export class SlurmBackend extends SshBackend {
	readonly slurmConfig: SlurmConfig;
	/** jobId → count of consecutive observations of COMPLETED without exit.code on disk (grace-window counter, see probeSettlement) */
	private readonly completedGrace = new Map<string, number>();

	constructor(cwd: string, config: SlurmConfig, name?: string) {
		super(cwd, config, name ?? `slurm:${config.host}`);
		this.slurmConfig = config;
	}

	override async submit(input: JobSpecInput): Promise<{ jobId: string }> {
		const spec = JobSpecSchema.parse(input);
		const jobId = uuidv7();
		const remoteDir = await this.prepareRemoteDir(jobId, spec);
		const script = buildSbatchScript(spec, jobId, remoteDir, this.slurmConfig);
		const upload = await this.ssh(`cat > '${remoteDir}/job.sh'`, { stdin: script, timeoutMs: 30_000 });
		if (upload.exitCode !== 0) throw new Error(`sbatch upload failed: ${upload.stderr.trim()}`);

		const submit = await this.ssh(`sbatch '${remoteDir}/job.sh'`, { timeoutMs: 30_000 });
		const slurmId = parseSbatchId(submit.stdout);
		if (submit.exitCode !== 0 || slurmId === undefined) {
			throw new Error(`sbatch failed: ${(submit.stderr || submit.stdout).trim()}`);
		}
		await this.recordJob(this.initialMeta(jobId, spec, "queued", `${slurmId}:${remoteDir}`), () =>
			this.ssh(`scancel ${slurmId}`, { timeoutMs: 20_000 }),
		);
		return { jobId };
	}

	protected override probeable(meta: JobStatus): boolean {
		if (!super.probeable(meta)) return false;
		const { slurmId, remoteDir } = parseSlurmHandle(meta.handle);
		return slurmId !== undefined && !!remoteDir;
	}

	protected override async probeSettlement(jobId: string, meta: JobStatus): Promise<JobStatus> {
		const { slurmId, remoteDir } = parseSlurmHandle(meta.handle);
		if (slurmId === undefined || !remoteDir) return meta; // probeable already filters this; keep direct calls safe
		const exitProbe = await this.ssh(`cat '${remoteDir}/exit.code' 2>/dev/null || echo PENDING`, { timeoutMs: 20_000 });
		const code = exitProbe.stdout.trim();
		if (code !== "PENDING" && code !== "") {
			this.completedGrace.delete(jobId);
			const exitCode = Number(code);
			const state = exitCode === 0 ? "completed" : "failed";
			const reason: JobStatus["reason"] =
				exitCode === 0 ? undefined : { kind: "executor", message: `slurm exit ${exitCode}` };
			const { status } = await this.settleTerminal(jobId, { ...meta, state, exitCode, settledAt: Date.now(), reason });
			return status;
		}

		// no || true / 2>/dev/null: we need the real exit code and stderr to distinguish "task vanished" from "the probe itself failed"
		const squeue = await this.ssh(`squeue -j ${slurmId} -o %T -h`, { timeoutMs: 20_000 });
		const probe = classifySqueueProbe(squeue.exitCode, squeue.stdout, squeue.stderr);
		if (probe.kind === "transient") return meta; // ssh/slurm transient fault: skip this round of polling, keep the current state

		if (probe.kind === "vanished") {
			// task vanished from slurm with no exit.code: can't prove it was preemption (could be expiry
			// cleanup/abnormal removal) — settle failed + executor, best-effort backfill exit code from sacct
			this.completedGrace.delete(jobId);
			const exitCode = await this.probeSacctExitCode(slurmId);
			const { status } = await this.settleTerminal(jobId, {
				...meta,
				state: "failed",
				exitCode,
				settledAt: Date.now(),
				reason: { kind: "executor", message: "slurm job vanished without exit.code" },
			});
			return status;
		}

		const stateRaw = probe.state;
		if (stateRaw === "COMPLETED") {
			// exit.code is written asynchronously by the runner (NFS may lag): give a bounded grace window,
			// settle failed past it, so COMPLETED-but-no-exit.code never sticks "running"
			const scans = (this.completedGrace.get(jobId) ?? 0) + 1;
			if (scans >= SLURM_COMPLETED_GRACE_SCANS) {
				this.completedGrace.delete(jobId);
				const { status } = await this.settleTerminal(jobId, {
					...meta,
					state: "failed",
					settledAt: Date.now(),
					reason: { kind: "executor", message: `slurm COMPLETED but exit.code missing after ${scans} polls` },
				});
				return status;
			}
			this.completedGrace.set(jobId, scans);
			return meta;
		}
		this.completedGrace.delete(jobId);

		const state = mapSlurmState(stateRaw);
		if (state === "preempted" || state === "failed") {
			// settle terminal states immediately: only the real preemption states (PREEMPTED/REVOKED) use
			// preempted kind; FAILED/CANCELLED/TIMEOUT/unknown → executor kind, raw slurm state in the detail
			const exitCode = await this.probeSacctExitCode(slurmId);
			const { status } = await this.settleTerminal(jobId, {
				...meta,
				state,
				exitCode,
				settledAt: Date.now(),
				reason: { kind: state === "preempted" ? "preempted" : "executor", message: `slurm state ${stateRaw}` },
			});
			return status;
		}
		if (state !== meta.state) {
			// non-terminal transition (queued→running): writeUnsettled re-checks so it can never overwrite a settlement
			return (await this.gate.writeUnsettled(this.cwd, jobId, (fresh) => ({ ...fresh, state }))) ?? meta;
		}
		return meta;
	}

	/** best-effort historical exit code via sacct (output shaped "exit:signal", e.g. "1:0"); returns undefined on failure/missing, never blocks settlement */
	private async probeSacctExitCode(slurmId: number): Promise<number | undefined> {
		const probe = await this.ssh(`sacct -j ${slurmId} -n -P -o ExitCode | head -n 1`, { timeoutMs: 20_000 });
		if (probe.exitCode !== 0) return undefined;
		const line = probe.stdout.trim().split("\n")[0]?.trim() ?? "";
		if (line === "") return undefined;
		const code = Number(line.split(":")[0]);
		return Number.isInteger(code) && code >= 0 ? code : undefined;
	}

	protected override async killRemote(handle: string | undefined): Promise<void> {
		const { slurmId } = parseSlurmHandle(handle);
		if (slurmId !== undefined) await this.ssh(`scancel ${slurmId}`, { timeoutMs: 20_000 });
	}
}

export function mapSlurmState(raw: string): "queued" | "running" | "failed" | "preempted" {
	switch (raw) {
		case "PENDING":
		case "CONFIGURING":
			return "queued";
		case "RUNNING":
		case "COMPLETING":
		case "COMPLETED": // exit.code written asynchronously by the runner; bounded grace when not on disk, see probeSettlement
		case "SUSPENDED": // suspension is usually recoverable, not terminal
			return "running";
		case "PREEMPTED": // genuinely preempted: the only state mapped to preempted (REVOKED = recalled because a peer was preempted)
		case "REVOKED":
			return "preempted";
		default:
			// FAILED/CANCELLED/TIMEOUT/NODE_FAIL/BOOT_FAIL/unknown: failed, kind set to executor by the caller
			return "failed";
	}
}

export type SqueueProbe =
	| { kind: "state"; state: string } // squeue returned a normal state line
	| { kind: "vanished" } // job id already gone from slurm (preempted/cleaned up, with no exit.code)
	| { kind: "transient" }; // ssh transport failure / slurm controller unreachable / abnormal empty output: skip this round

/** Classify a squeue probe result: transient faults never settle the task — skip this poll round and keep the current state (aligned with ssh treating empty output as PENDING). */
export function classifySqueueProbe(exitCode: number, stdout: string, stderr: string): SqueueProbe {
	const state = stdout.trim().split("\n")[0]?.trim() ?? "";
	if (exitCode === 0 && state) return { kind: "state", state };
	if (`${stderr}\n${stdout}`.toLowerCase().includes("invalid job id")) return { kind: "vanished" };
	return { kind: "transient" };
}
