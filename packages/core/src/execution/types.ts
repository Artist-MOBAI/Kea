import { z } from "zod";
import { truncateWithMarker } from "../text.ts";
import { JOB_DEFAULT_TIMEOUT_MS, MAX_TOOL_RESULT_CHARS } from "../timeouts.ts";

export const JobSpecSchema = z.object({
	command: z.string().min(1),
	label: z.string().optional(),
	image: z.string().optional(),
	timeoutMs: z.number().positive().default(JOB_DEFAULT_TIMEOUT_MS),
	env: z.record(z.string(), z.string()).optional(),
	resources: z
		.object({
			gpu: z.string().optional(),
			gpus: z.number().int().positive().optional(),
			cpus: z.number().int().positive().optional(),
			memoryMb: z.number().int().positive().optional(),
		})
		.optional(),

	syncPaths: z.array(z.string()).optional(),
});
export type JobSpec = z.infer<typeof JobSpecSchema>;

export type JobSpecInput = z.input<typeof JobSpecSchema>;

export const JOB_STATES = [
	"queued",
	"running",
	"checkpointed",
	"awaiting_human",
	"completed",
	"failed",
	"canceled",
	"preempted",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const SETTLED_STATES: readonly JobState[] = ["completed", "failed", "canceled", "preempted"];

export function isSettled(state: JobState): boolean {
	return (SETTLED_STATES as readonly string[]).includes(state);
}

export interface JobStatus {
	jobId: string;
	backend: string;
	state: JobState;
	label?: string;
	command: string;
	submittedAt: number;
	settledAt?: number;
	exitCode?: number;
	reason?: { kind: "user" | "system" | "executor" | "timeout" | "preempted"; message?: string };

	handle?: string;

	/** timeout at submit time (ms). Persisted into meta so that after a crash-restart reclaim can re-arm/settle by the original timeout instead of hard-coding a new value. */
	timeoutMs?: number;

	/** unsettled error (e.g. a human job's out-of-band result.json validation failure): state stays awaiting, but visible via job_status. */
	lastError?: string;
}

export interface JobResult extends JobStatus {
	stdout: string;
	stderr: string;
}

export interface ExecutionBackend {
	readonly name: string;
	submit(spec: JobSpecInput): Promise<{ jobId: string }>;
	status(jobId: string): Promise<JobStatus>;
	result(jobId: string): Promise<JobResult>;
	cancel(jobId: string): Promise<void>;

	reclaimOrphans(): Promise<number>;
}

export function truncateLog(text: string): string {
	return truncateWithMarker(text, MAX_TOOL_RESULT_CHARS, `\n… [log truncated at ${MAX_TOOL_RESULT_CHARS} chars]`);
}
