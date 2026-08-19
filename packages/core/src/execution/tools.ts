import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { JOB_LOG_TAIL_CHARS, JOB_RESULT_TAIL_CHARS } from "../timeouts.ts";
import type { BackendRegistry } from "./backend.ts";
import type { HumanBackend } from "./human.ts";
import { readLog, readMeta, scanJobIds, stderrPath, stdoutPath } from "./ledger.ts";
import { isSettled, JOB_STATES } from "./types.ts";

export interface JobToolsContext {
	registry: BackendRegistry;
	human: HumanBackend;
	cwd?: string;

	submitGuard?: () => string | undefined;
	onJobSubmitted?: (jobId: string, backend: string) => void;
	/** JobFinished hook wiring; fires on cancel/human settlement and other direct settlement paths */
	onJobSettled?: (jobId: string, backend: string, outcome: string) => void;
}

function ctxCwd(ctx: JobToolsContext): string {
	return ctx.cwd ?? process.cwd();
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text", text }], details };
}

function errorResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text", text }], details, isError: true };
}

export function createJobTools(ctx: JobToolsContext) {
	return [
		runExperimentTool(ctx),
		jobListTool(ctx),
		jobStatusTool(ctx),
		jobCancelTool(ctx),
		submitExperimentResultTool(ctx),
	];
}

const runExperimentParameters = Type.Object({
	command: Type.String({ description: "Shell command to run on the backend" }),
	backend: Type.Optional(
		Type.String({ description: "local | human | ssh:<host> | slurm:<host> | modal (default local)" }),
	),
	label: Type.Optional(Type.String()),
	timeout_ms: Type.Optional(Type.Number()),
	gpu: Type.Optional(Type.String({ description: "GPU type for modal, e.g. H100" })),
	sync_paths: Type.Optional(
		Type.Array(Type.String(), { description: "Workspace-relative paths to sync to remote backends" }),
	),
});

function runExperimentTool(ctx: JobToolsContext) {
	return {
		name: "run_experiment",
		label: "Run experiment",
		description: [
			"Submit a shell command as a background job on an execution backend (local/human/ssh/slurm/modal).",
			"The job's meta.json ledger (`.kea/jobs/<id>/meta.json`) is the single source of truth for its state — never infer state from process liveness or log activity.",
			"Returns a jobId; poll it with job_status, and prefer this over raw bash for anything long-running.",
		].join("\n"),
		parameters: runExperimentParameters,
		executionMode: "sequential",
		async execute(_id: string, params: Static<typeof runExperimentParameters>) {
			const guardReason = ctx.submitGuard?.();
			if (guardReason) return errorResult(`Rejected: ${guardReason}`, { rejected: true });
			const backendName = params.backend ?? "local";
			const backend = ctx.registry.get(backendName);
			if (!backend) {
				return errorResult(`Unknown backend "${backendName}". Available: ${ctx.registry.names().join(", ")}`);
			}
			try {
				const { jobId } = await backend.submit({
					command: params.command,
					label: params.label,
					timeoutMs: params.timeout_ms,
					resources: params.gpu ? { gpu: params.gpu } : undefined,
					syncPaths: params.sync_paths,
				});
				ctx.onJobSubmitted?.(jobId, backendName);
				return textResult(`Job ${jobId} submitted to backend "${backendName}". Use job_status to poll.`, {
					jobId,
					backend: backendName,
				});
			} catch (err) {
				return errorResult(
					`Submit failed on backend "${backendName}": ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	};
}

const jobIdParameters = Type.Object({ job_id: Type.String() });

const jobListParameters = Type.Object({
	state: Type.Optional(Type.String({ description: `Optional state filter: ${JOB_STATES.join(" | ")}` })),
});

function jobListTool(ctx: JobToolsContext) {
	return {
		name: "job_list",
		label: "List jobs",
		description: [
			"List background jobs recorded in this workspace (id, backend, state, label, created), with an optional state filter.",
			"The listing scans the meta.json ledger only — a job absent from the ledger does not exist, so never reason about unlisted jobs.",
			"For logs and results of a specific job, follow up with job_status.",
		].join("\n"),
		parameters: jobListParameters,
		executionMode: "sequential",
		async execute(_id: string, params: Static<typeof jobListParameters>) {
			if (params.state && !(JOB_STATES as readonly string[]).includes(params.state)) {
				return errorResult(`Unknown state "${params.state}". Valid: ${JOB_STATES.join(", ")}`);
			}
			const cwd = ctxCwd(ctx);
			const scan = await scanJobIds(cwd);
			if (!scan.ok) return errorResult("job ledger scan failed (I/O error)");
			const rows: string[] = [];
			for (const jobId of scan.ids) {
				// a single unparsable meta must not fail the whole listing
				const meta = await readMeta(cwd, jobId).catch(() => undefined);
				if (!meta) continue;
				if (params.state && meta.state !== params.state) continue;
				const created = new Date(meta.submittedAt).toISOString();
				rows.push(
					`${meta.jobId} backend=${meta.backend} state=${meta.state}${meta.label ? ` label=${meta.label}` : ""} created=${created}`,
				);
			}
			if (rows.length === 0) {
				return textResult(params.state ? `no jobs in state "${params.state}"` : "no jobs", { count: 0 });
			}
			return textResult(rows.join("\n"), { count: rows.length });
		},
	};
}

function jobStatusTool(ctx: JobToolsContext) {
	return {
		name: "job_status",
		label: "Job status",
		description: [
			"Poll one job's state, logs, and result.",
			"The meta.json ledger is the single source of truth for the state; for a running local job the tail of the already-flushed on-disk logs is returned, and settled jobs include the result tail (exit code, stdout/stderr).",
			"Poll long-running experiments with this instead of re-running them.",
		].join("\n"),
		parameters: jobIdParameters,
		executionMode: "sequential",
		async execute(_id: string, params: Static<typeof jobIdParameters>) {
			const backend = await ctx.registry.backendOfJob(params.job_id);
			if (!backend) {
				// backendOfJob returns undefined both for a missing meta and an unregistered backend —
				// only the former is an unknown job; the latter still has on-disk artifacts to read
				const meta = await readMeta(ctxCwd(ctx), params.job_id).catch(() => undefined);
				if (!meta) return errorResult(`Unknown job ${params.job_id}`);
				return errorResult(
					`job ${params.job_id} ran on backend "${meta.backend}" which is not registered in this workspace — read .kea/jobs/${params.job_id}/meta.json and the log files directly`,
				);
			}
			const status = await backend.status(params.job_id);
			const lines = [`job=${status.jobId} backend=${status.backend} state=${status.state}`];
			if (status.label) lines.push(`label=${status.label}`);
			// unsettled errors (e.g. a human job's bad result.json) must be visible, otherwise it stays stuck in awaiting_human forever
			if (status.lastError) lines.push(`lastError: ${status.lastError}`);
			if (status.state === "running") {
				if (status.backend === "local") {
					// only the local backend streams stdout/stderr into the ledger dir while the job runs
					const cwd = ctxCwd(ctx);
					const stdout = await readLog(stdoutPath(cwd, params.job_id)).catch(() => "");
					const stderr = await readLog(stderrPath(cwd, params.job_id)).catch(() => "");
					if (stdout !== "") lines.push(`--- stdout (tail, streaming) ---\n${stdout.slice(-JOB_LOG_TAIL_CHARS)}`);
					if (stderr.trim() !== "")
						lines.push(`--- stderr (tail, streaming) ---\n${stderr.slice(-JOB_LOG_TAIL_CHARS)}`);
				} else {
					lines.push("logs stream on the backend host");
				}
			}
			if (isSettled(status.state)) {
				const result = await backend.result(params.job_id);
				lines.push(`exit=${result.exitCode ?? "?"}`);
				lines.push(`--- stdout (tail) ---\n${result.stdout.slice(-JOB_RESULT_TAIL_CHARS)}`);
				if (result.stderr.trim() !== "")
					lines.push(`--- stderr (tail) ---\n${result.stderr.slice(-JOB_LOG_TAIL_CHARS)}`);
			}
			return textResult(lines.join("\n"), { state: status.state });
		},
	};
}

function jobCancelTool(ctx: JobToolsContext) {
	return {
		name: "job_cancel",
		label: "Cancel job",
		description: [
			"Cancel a queued/running/awaiting job.",
			"The ledger is settled before the process is killed (SettleGate) — a canceled job always ends with a settled state in meta.json, never a silent disappearance.",
			"After canceling, confirm the final state with job_status.",
		].join("\n"),
		parameters: jobIdParameters,
		executionMode: "sequential",
		async execute(_id: string, params: Static<typeof jobIdParameters>) {
			const backend = await ctx.registry.backendOfJob(params.job_id);
			if (!backend) return errorResult(`Unknown job ${params.job_id}`);
			await backend.cancel(params.job_id);
			// fire the hook after cancel settles; a status read failure does not affect the cancel result
			const status = await backend.status(params.job_id).catch(() => undefined);
			if (status && isSettled(status.state)) ctx.onJobSettled?.(params.job_id, status.backend, status.state);
			return textResult(`Job ${params.job_id} canceled.`);
		},
	};
}

const submitResultParameters = Type.Object({
	job_id: Type.String(),
	success: Type.Boolean(),
	notes: Type.Optional(Type.String()),
	metrics: Type.Optional(Type.Record(Type.String(), Type.Number())),
});

function submitExperimentResultTool(ctx: JobToolsContext) {
	return {
		name: "submit_experiment_result",
		label: "Submit experiment result",
		description: [
			"Report the outcome of a human-performed experiment (wet lab / instrument run / manual synthesis).",
			"The result settles the job by writing its meta.json ledger entry — call this only for jobs on the human backend, never to overwrite a machine-run job.",
			"After submitting, the job is settled; read job_status to confirm the final state.",
		].join("\n"),
		parameters: submitResultParameters,
		executionMode: "sequential",
		async execute(_id: string, params: Static<typeof submitResultParameters>) {
			try {
				const settled = await ctx.human.reportResult(params.job_id, {
					success: params.success,
					notes: params.notes,
					metrics: params.metrics,
				});
				ctx.onJobSettled?.(params.job_id, settled.backend, settled.state);
				return textResult(`Job ${params.job_id} settled: ${settled.state}`, { state: settled.state });
			} catch (err) {
				return errorResult(err instanceof Error ? err.message : String(err));
			}
		},
	};
}
