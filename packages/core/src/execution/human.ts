import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { jobDir, readLog, readMeta, stderrPath, stdoutPath, writeMeta } from "./ledger.ts";
import {
	type ExecutionBackend,
	isSettled,
	type JobResult,
	type JobSpecInput,
	JobSpecSchema,
	type JobStatus,
	truncateLog,
} from "./types.ts";

/** out-of-band result.json validation (fail-closed): success must be a boolean, metrics a numeric record, notes optional. */
const HumanReportSchema = z.object({
	success: z.boolean(),
	metrics: z.record(z.string(), z.number()).optional(),
	notes: z.string().optional(),
});

export type HumanReport = z.infer<typeof HumanReportSchema>;

export class HumanBackend implements ExecutionBackend {
	readonly name = "human";

	constructor(private readonly cwd: string) {}

	async submit(input: JobSpecInput): Promise<{ jobId: string }> {
		const spec = JobSpecSchema.parse(input);
		const jobId = uuidv7();
		const dir = jobDir(this.cwd, jobId);
		const instructions = [
			`# Experiment ${jobId}${spec.label ? ` — ${spec.label}` : ""}`,
			"",
			"Please run the experiment below, then backfill the result with the `submit_experiment_result` tool (or by writing result.json in this directory).",
			"",
			"## Task",
			spec.command,
			"",
			"## result.json format (optional out-of-band backfill)",
			'`{ "success": true, "notes": "...", "metrics": { "yield": 0.42 } }`',
		].join("\n");
		await Bun.write(join(dir, "instructions.md"), instructions);
		await writeMeta(this.cwd, {
			jobId,
			backend: this.name,
			state: "awaiting_human",
			label: spec.label,
			command: spec.command,
			submittedAt: Date.now(),
		});
		return { jobId };
	}

	async status(jobId: string): Promise<JobStatus> {
		const meta = await readMeta(this.cwd, jobId);
		if (!meta) throw new Error(`unknown job ${jobId}`);
		if (meta.state === "awaiting_human") return await this.settleOutOfBand(jobId, meta);
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
		const meta = await readMeta(this.cwd, jobId);
		if (!meta) throw new Error(`unknown job ${jobId}`);
		if (meta.state !== "awaiting_human")
			throw new Error(`only awaiting_human jobs can be canceled (state=${meta.state})`);
		await writeMeta(this.cwd, {
			...meta,
			state: "canceled",
			settledAt: Date.now(),
			reason: { kind: "user", message: "canceled before human execution" },
		});
	}

	async reclaimOrphans(): Promise<number> {
		return 0;
	}

	async reportResult(jobId: string, report: HumanReport): Promise<JobStatus> {
		const meta = await readMeta(this.cwd, jobId);
		if (!meta) throw new Error(`unknown job ${jobId}`);
		// idempotent settlement: a concurrent poll (status() racing reportResult) reaching here second returns the existing meta without throwing.
		// first settlement wins; later ones don't overwrite, avoiding an "already settled" exception surfacing to the tool layer.
		if (isSettled(meta.state)) return meta;
		if (meta.state !== "awaiting_human") throw new Error(`job ${jobId} is not awaiting_human (${meta.state})`);

		const metricLines = Object.entries(report.metrics ?? {}).map(([k, v]) => `METRIC ${k}=${v}`);
		const stdout = [...(report.notes ? [report.notes] : []), ...metricLines].join("\n");
		await Bun.write(stdoutPath(this.cwd, jobId), stdout);
		const settled: JobStatus = {
			...meta,
			state: report.success ? "completed" : "failed",
			exitCode: report.success ? 0 : 1,
			settledAt: Date.now(),
			reason: report.success ? undefined : { kind: "executor", message: "human reported failure" },
			lastError: undefined,
		};
		await writeMeta(this.cwd, settled);
		return settled;
	}

	/**
	 * Single entry for out-of-band result.json settlement (status() polling and result() both go through it).
	 * File missing → return the unsettled meta as-is; JSON corrupt or invalid → neither settle nor swallow the
	 * error, write it into meta.lastError (state stays awaiting_human), job_status carries it into the tool
	 * result; validation passes → settle via reportResult.
	 */
	private async settleOutOfBand(jobId: string, meta: JobStatus): Promise<JobStatus> {
		const file = Bun.file(join(jobDir(this.cwd, jobId), "result.json"));
		if (!(await file.exists())) return meta;
		let report: HumanReport;
		try {
			report = HumanReportSchema.parse(await file.json());
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			const lastError = `result.json invalid, not settled: ${detail}`.slice(0, 500);
			// rewrite meta only when lastError actually changed: concurrent/repeated polls no longer race-write the same file
			if (meta.lastError !== lastError) await writeMeta(this.cwd, { ...meta, lastError });
			return { ...meta, lastError };
		}
		return await this.reportResult(jobId, report);
	}
}
