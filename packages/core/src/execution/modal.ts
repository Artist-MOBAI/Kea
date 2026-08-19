import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { jobDir, readLog, stderrPath, stdoutPath } from "./ledger.ts";
import { processAlive } from "./local.ts";
import { RemoteBackend } from "./remote-backend.ts";
import { shellQuote } from "./ssh.ts";
import {
	type JobResult,
	type JobSpec,
	type JobSpecInput,
	JobSpecSchema,
	type JobStatus,
	truncateLog,
} from "./types.ts";

export function buildModalScript(spec: JobSpec, jobId: string, exitFile: string): string {
	const gpu = spec.resources?.gpu ?? "A100";
	const timeoutS = Math.ceil(spec.timeoutMs / 1000);
	return [
		"import modal, pathlib",
		`JOB_ID = ${JSON.stringify(jobId)}`,
		`gpu = ${JSON.stringify(gpu)}`,
		`sb = modal.Sandbox.create(timeout=${timeoutS}, name=f"kea-{JOB_ID}")`,
		`print(f"SBID:{sb.object_id}", flush=True)`,
		`proc = sb.exec("bash", "-lc", ${JSON.stringify(spec.command)})`,
		"proc.wait()",
		`pathlib.Path(${JSON.stringify(exitFile)}).write_text(str(proc.returncode))`,
		"sb.terminate()",
	].join("\n");
}

export class ModalBackend extends RemoteBackend {
	override readonly name = "modal";

	async available(): Promise<boolean> {
		try {
			const proc = Bun.spawn(["modal", "--version"], { stdout: "ignore", stderr: "ignore" });
			return (await proc.exited) === 0;
		} catch {
			return false;
		}
	}

	override async submit(input: JobSpecInput): Promise<{ jobId: string }> {
		if (!(await this.available())) throw new Error("modal CLI unavailable (pip install modal && modal setup)");
		const spec = JobSpecSchema.parse(input);
		const jobId = uuidv7();
		const dir = jobDir(this.cwd, jobId);
		const exitFile = join(dir, "exit.code");
		const scriptPath = join(dir, "modal_job.py");
		await Bun.write(scriptPath, buildModalScript(spec, jobId, exitFile));

		const launchLog = join(dir, "launch.log");
		const launchCmd = `nohup modal run ${shellQuote(scriptPath)} > ${shellQuote(launchLog)} 2>&1 & echo $!`;
		const proc = Bun.spawn(["/bin/bash", "-c", launchCmd], {
			cwd: this.cwd,
			stdout: "pipe",
			stderr: "ignore",
		});
		const launcherPid = (await new Response(proc.stdout).text()).trim();

		await this.recordJob(this.initialMeta(jobId, spec, "running", launcherPid), async () => {
			try {
				process.kill(Number(launcherPid));
			} catch {
				// already exited / invalid pid
			}
			// the remote sandbox may already exist and outlive the killed launcher: terminate it when the
			// SBID was printed before we got here; if not, it leaks (error path, recovery stays bounded)
			try {
				const sbMatch = /SBID:([A-Za-z0-9-]+)/.exec(await readLog(launchLog));
				if (sbMatch?.[1]) await this.terminateSandbox(sbMatch[1]);
			} catch {
				// log not written yet / sandbox unknown
			}
		});
		return { jobId };
	}

	protected override probeable(_meta: JobStatus): boolean {
		return true;
	}

	protected override async probeSettlement(jobId: string, meta: JobStatus): Promise<JobStatus> {
		const dir = jobDir(this.cwd, jobId);
		const sbMatch = /SBID:([A-Za-z0-9-]+)/.exec(await readLog(join(dir, "launch.log")));
		const handle = sbMatch?.[1] ? `${meta.handle}|${sbMatch[1]}` : meta.handle;

		const exitFile = Bun.file(join(dir, "exit.code"));
		if (await exitFile.exists()) {
			const raw = (await exitFile.text()).trim();
			const exitCode = Number(raw);
			// empty/half-written file (runner hasn't finished writing) → invalid Number result: treat as not
			// written, skip this round's settlement, never write NaN (JSON null) into meta
			if (raw !== "" && Number.isInteger(exitCode)) {
				const state = exitCode === 0 ? "completed" : "failed";
				const reason: JobStatus["reason"] =
					exitCode === 0 ? undefined : { kind: "executor", message: `sandbox exit ${exitCode}` };
				const { status } = await this.settleTerminal(jobId, {
					...meta,
					handle,
					state,
					exitCode,
					settledAt: Date.now(),
					reason,
				});
				return status;
			}
		}
		const [launcherPart, sandboxId] = (handle ?? "").split("|");
		const launcherPid = Number(launcherPart);
		if (Number.isFinite(launcherPid) && launcherPid > 0 && !processAlive(launcherPid)) {
			// dead launcher + no exit.code: nobody will ever write the outcome (reclaim only runs at startup) —
			// settle failed here or the job stays running forever in-process
			const { won, status } = await this.settleTerminal(jobId, {
				...meta,
				handle,
				state: "failed",
				settledAt: Date.now(),
				reason: { kind: "executor", message: "modal launcher exited without exit.code (task vanished)" },
			});
			// settle-before-kill: the leftover sandbox must not outlive the settle (reclaim skips settled jobs)
			if (won && sandboxId) await this.terminateSandbox(sandboxId);
			return status;
		}
		if (handle !== meta.handle) {
			// non-terminal handle refresh: writeUnsettled re-checks so it can never overwrite a settlement
			return (await this.gate.writeUnsettled(this.cwd, jobId, (fresh) => ({ ...fresh, handle }))) ?? meta;
		}
		return meta;
	}

	override async result(jobId: string): Promise<JobResult> {
		const meta = await this.status(jobId);
		const dir = jobDir(this.cwd, jobId);
		const stdout = await readLog(join(dir, "launch.log"));
		const stderr = await readLog(stderrPath(this.cwd, jobId));
		await Bun.write(stdoutPath(this.cwd, jobId), stdout);
		return { ...meta, stdout: truncateLog(stdout), stderr: truncateLog(stderr) };
	}

	protected override async killRemote(handle: string | undefined): Promise<void> {
		const [launcherPart, sandboxId] = (handle ?? "").split("|");
		const pid = Number(launcherPart);
		if (Number.isInteger(pid) && pid > 0) {
			try {
				// SIGTERM matches a bare shell `kill <pid>`'s default signal
				process.kill(pid, "SIGTERM");
			} catch {
				// ESRCH etc.: launcher already exited
			}
		}
		if (sandboxId) await this.terminateSandbox(sandboxId);
	}

	private async terminateSandbox(sandboxId: string): Promise<void> {
		// env: process.env — Bun resolves PATH from the spawn-time env, so runtime PATH updates are honored
		await Bun.spawn(["modal", "sandbox", "terminate", sandboxId], { env: process.env }).exited.catch(() => {});
	}
}
