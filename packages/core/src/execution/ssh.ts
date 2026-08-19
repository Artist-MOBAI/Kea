import { uuidv7 } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { stderrPath, stdoutPath } from "./ledger.ts";
import { RemoteBackend } from "./remote-backend.ts";
import {
	type JobResult,
	type JobSpec,
	type JobSpecInput,
	JobSpecSchema,
	type JobStatus,
	truncateLog,
} from "./types.ts";

export const SshConfigSchema = z.object({
	host: z.string().min(1),
	user: z.string().optional(),
	port: z.number().int().positive().optional(),
	identityFile: z.string().optional(),
	remoteRoot: z.string().default("~/.kea-jobs"),
});
export type SshConfig = z.infer<typeof SshConfigSchema>;

export function sshBaseArgs(config: SshConfig): string[] {
	const args = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15"];
	if (config.port) args.push("-p", String(config.port));
	if (config.identityFile) args.push("-i", config.identityFile);
	args.push(config.user ? `${config.user}@${config.host}` : config.host);
	return args;
}

export function buildRunScript(spec: JobSpec, _jobId: string, remoteDir: string, timeoutS: number): string {
	// self-harvest runner: the script records its own exit code (a sub-shell wait on a non-child writes 127
	// immediately); kea.pid enables a precise tree kill, nohup "$PWD/kea-run.sh" carries remoteDir for the
	// pkill -f fallback (a bare kea-run.sh would match every job on the host)
	return [
		"#!/bin/bash",
		`cd '${remoteDir}' || exit 97`,
		"cat > kea-run.sh <<'KEA_RUNNER_EOF'",
		"echo $$ > kea.pid",
		// timeout may be gtimeout or missing on BSD/macOS: if present, bound it; if absent, run directly (don't fake 127)
		"T=$(command -v timeout || command -v gtimeout || true)",
		`if [ -n "$T" ]; then "$T" ${timeoutS} bash -c ${shellQuote(spec.command)}; else bash -c ${shellQuote(spec.command)}; fi`,
		"echo $? > exit.code",
		"KEA_RUNNER_EOF",
		'nohup bash "$PWD/kea-run.sh" > stdout.log 2> stderr.log &',
		"disown -a || true",
	].join("\n");
}

/**
 * Remote kill command: kea.pid records the runner's pid (the timeout-wrapped parent process). pkill -P only
 * kills direct children, so go one level deeper to collect grandchildren; when kea.pid is missing (jobs from
 * older versions) fall back to pkill -f by full path (runner cmdline contains $PWD/kea-run.sh).
 */
export function buildKillCommand(remoteDir: string): string {
	return [
		`cd ${shellQuote(remoteDir)} 2>/dev/null || exit 0`,
		"if [ -f kea.pid ]; then PID=$(cat kea.pid)",
		'for c in $(pgrep -P "$PID" 2>/dev/null); do pkill -P "$c" 2>/dev/null; kill "$c" 2>/dev/null; done',
		'kill "$PID" 2>/dev/null; fi',
		`pkill -f ${shellQuote(`${remoteDir}/kea-run.sh`)} 2>/dev/null`,
		"true",
	].join("; ");
}

export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class SshBackend extends RemoteBackend {
	override readonly name: string;

	constructor(
		cwd: string,
		readonly config: SshConfig,
		name?: string,
	) {
		super(cwd);
		this.name = name ?? `ssh:${config.host}`;
	}

	protected async ssh(
		command: string,
		options: { stdin?: string; timeoutMs?: number } = {},
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const args = [...sshBaseArgs(this.config), command];
		const proc = Bun.spawn(args, {
			stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const timer = options.timeoutMs ? setTimeout(() => proc.kill(), options.timeoutMs) : undefined;
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		if (timer) clearTimeout(timer);
		return { exitCode, stdout, stderr };
	}

	protected remoteDirFor(jobId: string): string {
		return `${this.config.remoteRoot}/${jobId}`;
	}

	/** shared ssh/slurm submit prologue: mkdir the remote job dir, then sync workspace paths when asked. */
	protected async prepareRemoteDir(jobId: string, spec: JobSpec): Promise<string> {
		const remoteDir = this.remoteDirFor(jobId);
		const mkdir = await this.ssh(`mkdir -p '${remoteDir}'`, { timeoutMs: 30_000 });
		if (mkdir.exitCode !== 0) throw new Error(`ssh mkdir failed: ${mkdir.stderr.trim()}`);
		if (spec.syncPaths && spec.syncPaths.length > 0) await this.syncWorkspace(jobId, spec.syncPaths);
		return remoteDir;
	}

	override async submit(input: JobSpecInput): Promise<{ jobId: string }> {
		const spec = JobSpecSchema.parse(input);
		const jobId = uuidv7();
		const remoteDir = await this.prepareRemoteDir(jobId, spec);
		const script = buildRunScript(spec, jobId, remoteDir, Math.ceil(spec.timeoutMs / 1000));
		const upload = await this.ssh(`cat > '${remoteDir}/run.sh'`, { stdin: script, timeoutMs: 30_000 });
		if (upload.exitCode !== 0) throw new Error(`ssh upload failed: ${upload.stderr.trim()}`);
		const start = await this.ssh(`bash '${remoteDir}/run.sh'`, { timeoutMs: 30_000 });
		if (start.exitCode !== 0) throw new Error(`ssh start failed: ${start.stderr.trim()}`);
		await this.recordJob(this.initialMeta(jobId, spec, "running", remoteDir), () =>
			this.ssh(buildKillCommand(remoteDir), { timeoutMs: 20_000 }),
		);
		return { jobId };
	}

	protected async syncWorkspace(jobId: string, syncPaths: string[]): Promise<void> {
		const remoteDir = this.remoteDirFor(jobId);
		const tarArgs = ["tar", "-czf", "-", ...syncPaths];
		const sshArgs = sshBaseArgs(this.config);
		const pipeline = `${tarArgs.map(shellQuote).join(" ")} | ${sshArgs.map(shellQuote).join(" ")} 'tar -xzf - -C ${shellQuote(remoteDir)}'`;
		const proc = Bun.spawn(["/bin/bash", "-c", pipeline], {
			cwd: this.cwd,
			stdout: "ignore",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		if (exitCode !== 0) throw new Error(`workspace sync failed: ${stderr.trim()}`);
	}

	protected override async probeSettlement(jobId: string, meta: JobStatus): Promise<JobStatus> {
		const probe = await this.ssh(`cat '${meta.handle}/exit.code' 2>/dev/null || echo PENDING`, {
			timeoutMs: 20_000,
		});
		const code = probe.stdout.trim();
		if (code === "PENDING" || code === "") return meta;
		const exitCode = Number(code);
		const timedOut = exitCode === 124;
		const state = exitCode === 0 ? "completed" : "failed";
		const reason: JobStatus["reason"] =
			exitCode === 0
				? undefined
				: timedOut
					? { kind: "timeout", message: "remote timeout" }
					: { kind: "executor", message: `remote exit ${exitCode}` };
		const { status } = await this.settleTerminal(jobId, { ...meta, state, exitCode, settledAt: Date.now(), reason });
		return status;
	}

	override async result(jobId: string): Promise<JobResult> {
		const meta = await this.status(jobId);
		let stdout = "";
		let stderr = "";
		if (meta.handle) {
			const out = await this.ssh(`cat '${meta.handle}/stdout.log' 2>/dev/null`, { timeoutMs: 30_000 });
			const err = await this.ssh(`cat '${meta.handle}/stderr.log' 2>/dev/null`, { timeoutMs: 30_000 });
			stdout = out.stdout;
			stderr = err.stdout;
			await Bun.write(stdoutPath(this.cwd, jobId), stdout);
			await Bun.write(stderrPath(this.cwd, jobId), stderr);
		}
		return { ...meta, stdout: truncateLog(stdout), stderr: truncateLog(stderr) };
	}

	protected override async killRemote(handle: string | undefined): Promise<void> {
		if (!handle) return;
		// kill via the kea.pid process tree: the worker cmdline (timeout N bash -c '<cmd>') carries no
		// remoteDir, so a pkill -f on remoteDir would never match
		await this.ssh(buildKillCommand(handle), { timeoutMs: 20_000 });
	}
}
