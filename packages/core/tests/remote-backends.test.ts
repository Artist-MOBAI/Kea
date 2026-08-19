import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { jobDir, readMeta, writeMeta } from "../src/execution/ledger.ts";
import { buildModalScript, ModalBackend } from "../src/execution/modal.ts";
import {
	buildSbatchScript,
	classifySqueueProbe,
	mapSlurmState,
	parseSbatchId,
	parseSlurmHandle,
	SLURM_COMPLETED_GRACE_SCANS,
	SlurmBackend,
} from "../src/execution/slurm.ts";
import { buildKillCommand, buildRunScript, SshBackend, shellQuote, sshBaseArgs } from "../src/execution/ssh.ts";
import type { JobSpec } from "../src/execution/types.ts";

const spec: JobSpec = {
	command: "python train.py",
	label: "train",
	timeoutMs: 600_000,
	env: { SEED: "7" },
	resources: { gpus: 2, cpus: 4, memoryMb: 8192 },
};

describe("SSH construction (M4)", () => {
	test("base args: BatchMode/keepalive/port/identity", () => {
		const args = sshBaseArgs({
			host: "hpc.example",
			user: "alice",
			port: 2222,
			identityFile: "~/.ssh/id_ed25519",
			remoteRoot: "~/.kea-jobs",
		});
		const joined = args.join(" ");
		expect(joined).toContain("BatchMode=yes");
		expect(joined).toContain("ConnectTimeout=10");
		expect(joined).toContain("-p 2222");
		expect(joined).toContain("-i ~/.ssh/id_ed25519");
		expect(joined).toContain("alice@hpc.example");
	});

	test("run script: self-reaping wrapper (timeout probe + exit code recorded inside the runner script + kea.pid)", () => {
		const script = buildRunScript(spec, "job-1", "~/.kea-jobs/job-1", 600);
		expect(script).toContain("cd '~/.kea-jobs/job-1'");
		expect(script).toContain("echo $$ > kea.pid");
		expect(script).toContain("T=$(command -v timeout || command -v gtimeout || true)");
		expect(script).toContain('"$T" 600 bash -c');
		expect(script).toContain("echo $? > exit.code");
		expect(script).toContain('nohup bash "$PWD/kea-run.sh" > stdout.log 2> stderr.log &');
		expect(script).not.toContain("wait $worker");
	});

	test("run script behavior: locally reaps the real command exit code", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kea-ssh-script-"));
		try {
			const exitSpec: JobSpec = { ...spec, command: "echo hello-out; echo err-out >&2; exit 3" };
			const script = buildRunScript(exitSpec, "job-x", dir, 60);
			const scriptPath = join(dir, "submit.sh");
			await Bun.write(scriptPath, script);
			const proc = Bun.spawn(["bash", scriptPath], { cwd: dir, stdout: "pipe", stderr: "pipe" });
			await proc.exited;

			let code = "";
			for (let i = 0; i < 200; i++) {
				const f = Bun.file(join(dir, "exit.code"));
				if (await f.exists()) {
					code = (await f.text()).trim();
					break;
				}
				await Bun.sleep(50);
			}
			expect(code).toBe("3");
			const stdout = await Bun.file(join(dir, "stdout.log")).text();
			const stderr = await Bun.file(join(dir, "stderr.log")).text();
			expect(stdout).toContain("hello-out");
			expect(stderr).toContain("err-out");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 20_000);

	test("run script behavior: reaps 124 when timeout exists; falls back to direct execution when missing, never forges 127", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kea-ssh-timeout-"));
		try {
			const slowSpec: JobSpec = { ...spec, command: "sleep 2" };
			const script = buildRunScript(slowSpec, "job-t", dir, 1);
			const scriptPath = join(dir, "submit.sh");
			await Bun.write(scriptPath, script);
			const proc = Bun.spawn(["bash", scriptPath], { cwd: dir, stdout: "pipe", stderr: "pipe" });
			await proc.exited;

			let code = "";
			for (let i = 0; i < 200; i++) {
				const f = Bun.file(join(dir, "exit.code"));
				if (await f.exists()) {
					code = (await f.text()).trim();
					break;
				}
				await Bun.sleep(50);
			}
			// Probe whether this host has timeout/gtimeout: if present, reap with the bounded 124; if missing, fall back to running directly (sleep completes → 0)
			const probe = Bun.spawn(["bash", "-c", "command -v timeout || command -v gtimeout"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const hasTimeout = (await probe.exited) === 0;
			expect(code).toBe(hasTimeout ? "124" : "0");
			// In either case, never emit the bogus 127
			expect(code).not.toBe("127");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 20_000);

	test("shellQuote escapes single quotes", () => {
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});

	test("buildKillCommand: pidfile tree kill + remoteDir-scoped fallback pkill", () => {
		const cmd = buildKillCommand("/tmp/stub/job-1");
		expect(cmd).toContain("cd '/tmp/stub/job-1'");
		expect(cmd).toContain("PID=$(cat kea.pid)");
		expect(cmd).toContain('pgrep -P "$PID"');
		expect(cmd).toContain('pkill -P "$c"');
		expect(cmd).toContain('kill "$PID"');
		expect(cmd).toContain("pkill -f '/tmp/stub/job-1/kea-run.sh'");
	});

	test("cancel behavior: kea.pid process-tree kill truly reaps the runner and the inner command", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kea-ssh-kill-"));
		try {
			const sleepSpec: JobSpec = { ...spec, command: "sleep 30" };
			await Bun.write(join(dir, "submit.sh"), buildRunScript(sleepSpec, "job-k", dir, 60));
			const launcher = Bun.spawn(["bash", join(dir, "submit.sh")], { cwd: dir, stdout: "pipe", stderr: "pipe" });
			await launcher.exited;

			let pidText = "";
			for (let i = 0; i < 200; i++) {
				const f = Bun.file(join(dir, "kea.pid"));
				if (await f.exists()) {
					pidText = (await f.text()).trim();
					if (pidText) break;
				}
				await Bun.sleep(50);
			}
			expect(pidText).not.toBe("");
			const root = Number(pidText);

			// record the tree before killing: it must have >1 member, or there are no descendants to prove reaped
			const collectTree = (pid: number): number[] => {
				const kids = Bun.spawnSync(["bash", "-c", `pgrep -P ${pid} || true`])
					.stdout.toString()
					.split(/\s+/)
					.filter(Boolean)
					.map(Number);
				return [pid, ...kids.flatMap((k) => collectTree(k))];
			};
			const tree = collectTree(root);
			expect(tree.length).toBeGreaterThan(1);

			const kill = Bun.spawn(["bash", "-c", buildKillCommand(dir)], { stdout: "ignore", stderr: "ignore" });
			await kill.exited;

			// the kill command must reap the whole tree, not just the launcher
			const deadline = Date.now() + 5000;
			const alive = (pid: number) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			while (tree.some(alive) && Date.now() < deadline) await Bun.sleep(100);
			expect(tree.filter(alive)).toEqual([]);
			// the kill command must not forge exit.code (bogus 127)
			const exitFile = Bun.file(join(dir, "exit.code"));
			if (await exitFile.exists()) expect((await exitFile.text()).trim()).not.toBe("127");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("Slurm construction (M4)", () => {
	test("sbatch script maps resources and sbatch extras", () => {
		const script = buildSbatchScript(spec, "job-1", "~/.kea-jobs/job-1", {
			host: "cluster",
			remoteRoot: "~/.kea-jobs",
			partition: "gpu",
			account: "lab-123",
			extraSbatch: ["--constraint=a100"],
		});
		expect(script).toContain("#SBATCH --partition=gpu");
		expect(script).toContain("#SBATCH --account=lab-123");
		expect(script).toContain("#SBATCH --mem=8192");
		expect(script).toContain("#SBATCH --cpus-per-task=4");
		expect(script).toContain("#SBATCH --gpus=2");
		expect(script).toContain("#SBATCH --constraint=a100");
		expect(script).toContain("#SBATCH --output=~/.kea-jobs/job-1/stdout.log");
	});

	test("parseSbatchId extracts job id", () => {
		expect(parseSbatchId("Submitted batch job 424242")).toBe(424242);
		expect(parseSbatchId("error: invalid partition")).toBeUndefined();
	});

	test("squeue state mapping", () => {
		expect(mapSlurmState("PENDING")).toBe("queued");
		expect(mapSlurmState("RUNNING")).toBe("running");
		expect(mapSlurmState("COMPLETED")).toBe("running"); // with exit.code not yet written, use the bounded grace, not a terminal state
		expect(mapSlurmState("")).toBe("failed");
		expect(mapSlurmState("CANCELLED")).toBe("failed");
		expect(mapSlurmState("TIMEOUT")).toBe("failed");
		// Only true preemption states map to preempted; REVOKED = withdrawn because a companion was preempted
		expect(mapSlurmState("PREEMPTED")).toBe("preempted");
		expect(mapSlurmState("REVOKED")).toBe("preempted");
		expect(mapSlurmState("SUSPENDED")).toBe("running");
	});

	test("squeue probe classification: state / vanished / transient", () => {
		expect(classifySqueueProbe(0, "RUNNING\n", "")).toEqual({ kind: "state", state: "RUNNING" });
		expect(classifySqueueProbe(0, "PENDING\n", "")).toEqual({ kind: "state", state: "PENDING" });
		expect(classifySqueueProbe(1, "", "slurm_load_jobs error: Invalid job id specified")).toEqual({
			kind: "vanished",
		});
		expect(classifySqueueProbe(255, "", "ssh: connect to host hpc port 22: Connection timed out")).toEqual({
			kind: "transient",
		});
		expect(classifySqueueProbe(1, "", "slurm_load_jobs error: Unable to contact slurm controller")).toEqual({
			kind: "transient",
		});
		expect(classifySqueueProbe(0, "", "")).toEqual({ kind: "transient" });
	});
});

describe("Modal script construction (M4)", () => {
	test("named sandbox + exit-file + SBID marker", () => {
		const script = buildModalScript({ ...spec, resources: { gpu: "H100" } }, "job-9", "/tmp/jobs/job-9/exit.code");
		expect(script).toContain('name=f"kea-{JOB_ID}"');
		expect(script).toContain('"H100"');
		expect(script).toContain("SBID:");
		expect(script).toContain("/tmp/jobs/job-9/exit.code");
	});
});

type SshResponse = { exitCode: number; stdout: string; stderr: string };
type SshResponder = (command: string) => Promise<SshResponse> | SshResponse;

const workdirs: string[] = [];

afterAll(async () => {
	await Promise.all(workdirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmpWorkdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "kea2-remote-"));
	workdirs.push(dir);
	return dir;
}

class StubSshBackend extends SshBackend {
	readonly commands: string[] = [];

	constructor(
		cwd: string,
		private readonly respond: SshResponder,
	) {
		super(cwd, { host: "stub", remoteRoot: "/tmp/stub" });
	}

	protected override async ssh(command: string): Promise<SshResponse> {
		this.commands.push(command);
		return this.respond(command);
	}
}

class StubSlurmBackend extends SlurmBackend {
	readonly commands: string[] = [];

	constructor(
		cwd: string,
		private readonly respond: SshResponder,
	) {
		super(cwd, { host: "stub", remoteRoot: "/tmp/stub" });
	}

	protected override async ssh(command: string): Promise<SshResponse> {
		this.commands.push(command);
		return this.respond(command);
	}
}

describe("SSH settle-before-kill (mock)", () => {
	test("cancel settles meta before remote pkill and keeps exit.code intact", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "ssh-cancel-1";
		await writeMeta(cwd, {
			jobId,
			backend: "ssh:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "/tmp/stub/ssh-cancel-1",
		});
		let stateSeenByKill: string | undefined;
		const backend = new StubSshBackend(cwd, async (cmd) => {
			if (cmd.includes("pkill")) stateSeenByKill = (await readMeta(cwd, jobId))?.state;
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		await backend.cancel(jobId);
		const meta = await readMeta(cwd, jobId);
		expect(meta?.state).toBe("canceled");
		expect(meta?.reason?.kind).toBe("user");
		expect(stateSeenByKill).toBe("canceled"); // settle before kill: meta is already terminal when the remote kill runs
		expect(backend.commands.some((c) => c.includes("pkill"))).toBe(true);
		expect(backend.commands.some((c) => c.includes("rm -f"))).toBe(false);
	});

	test("cancel after remote completion keeps completed and skips the remote kill", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "ssh-cancel-done";
		await writeMeta(cwd, {
			jobId,
			backend: "ssh:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "/tmp/stub/ssh-cancel-done",
		});
		const backend = new StubSshBackend(cwd, (cmd) => {
			if (cmd.includes("exit.code")) return { exitCode: 0, stdout: "0\n", stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		await backend.cancel(jobId);
		const meta = await readMeta(cwd, jobId);
		expect(meta?.state).toBe("completed");
		expect(meta?.exitCode).toBe(0);
		expect(backend.commands.some((c) => c.includes("kea-run.sh"))).toBe(false);
	});

	test("cancel with a throwing probe falls through to settle-canceled + remote kill", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "ssh-cancel-probe-err";
		await writeMeta(cwd, {
			jobId,
			backend: "ssh:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "/tmp/stub/ssh-cancel-probe-err",
		});
		const backend = new StubSshBackend(cwd, () => ({ exitCode: 0, stdout: "", stderr: "" }));
		backend.status = async (_jobId: string): Promise<never> => {
			throw new Error("probe failure");
		};
		await backend.cancel(jobId);
		const meta = await readMeta(cwd, jobId);
		expect(meta?.state).toBe("canceled");
		expect(meta?.reason?.kind).toBe("user");
		// the remote was unreachable at cancel time, so the real outcome is unverified — the reason must say so
		expect(meta?.reason?.message).toContain("canceled while remote unreachable (outcome unverified)");
		expect(backend.commands.some((c) => c.includes("kea-run.sh"))).toBe(true);
	});
});

describe("Slurm poll discipline (mock)", () => {
	test("cancel settles meta before scancel", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "slurm-cancel-1";
		await writeMeta(cwd, {
			jobId,
			backend: "slurm:stub",
			state: "queued",
			command: "true",
			submittedAt: Date.now(),
			handle: "777:/tmp/stub/slurm-cancel-1",
		});
		let stateSeenByScancel: string | undefined;
		const backend = new StubSlurmBackend(cwd, async (cmd) => {
			if (cmd.includes("scancel")) stateSeenByScancel = (await readMeta(cwd, jobId))?.state;
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		await backend.cancel(jobId);
		expect((await readMeta(cwd, jobId))?.state).toBe("canceled");
		expect(stateSeenByScancel).toBe("canceled");
	});

	test("status skips poll on transient squeue failure (state unchanged)", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "slurm-transient-1";
		await writeMeta(cwd, {
			jobId,
			backend: "slurm:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "4242:/tmp/stub/slurm-transient-1",
		});
		const backend = new StubSlurmBackend(cwd, (cmd) => {
			if (cmd.includes("exit.code")) return { exitCode: 0, stdout: "PENDING\n", stderr: "" };
			if (cmd.includes("squeue")) {
				return { exitCode: 255, stdout: "", stderr: "ssh: connect to host stub: Connection timed out" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const status = await backend.status(jobId);
		expect(status.state).toBe("running");
		expect((await readMeta(cwd, jobId))?.state).toBe("running");
	});

	test("status settles FAILED/executor when job vanished from squeue without exit.code", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "slurm-vanished-1";
		await writeMeta(cwd, {
			jobId,
			backend: "slurm:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "4243:/tmp/stub/slurm-vanished-1",
		});
		const backend = new StubSlurmBackend(cwd, (cmd) => {
			if (cmd.includes("exit.code")) return { exitCode: 0, stdout: "PENDING\n", stderr: "" };
			if (cmd.includes("squeue")) {
				return { exitCode: 1, stdout: "", stderr: "slurm_load_jobs error: Invalid job id specified" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const status = await backend.status(jobId);
		// vanished ≠ confirmed preemption: settle failed + executor, never the preempted kind
		expect(status.state).toBe("failed");
		expect(status.reason?.kind).toBe("executor");
		expect(status.reason?.message).toContain("vanished");
		expect((await readMeta(cwd, jobId))?.state).toBe("failed");
	});

	test("status settles PREEMPTED with preempted kind (only true preemption states do)", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "slurm-preempt-1";
		await writeMeta(cwd, {
			jobId,
			backend: "slurm:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "4244:/tmp/stub/slurm-preempt-1",
		});
		const backend = new StubSlurmBackend(cwd, (cmd) => {
			if (cmd.includes("exit.code")) return { exitCode: 0, stdout: "PENDING\n", stderr: "" };
			if (cmd.includes("squeue")) return { exitCode: 0, stdout: "PREEMPTED\n", stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const status = await backend.status(jobId);
		expect(status.state).toBe("preempted");
		expect(status.reason?.kind).toBe("preempted");
		expect(status.reason?.message).toContain("PREEMPTED");
	});

	test("status settles FAILED/CANCELLED as executor kind with slurm state in detail", async () => {
		for (const stateRaw of ["FAILED", "CANCELLED", "TIMEOUT"]) {
			const cwd = await tmpWorkdir();
			const jobId = `slurm-${stateRaw.toLowerCase()}-1`;
			await writeMeta(cwd, {
				jobId,
				backend: "slurm:stub",
				state: "running",
				command: "true",
				submittedAt: Date.now(),
				handle: `4245:/tmp/stub/${jobId}`,
			});
			const backend = new StubSlurmBackend(cwd, (cmd) => {
				if (cmd.includes("exit.code")) return { exitCode: 0, stdout: "PENDING\n", stderr: "" };
				if (cmd.includes("squeue")) return { exitCode: 0, stdout: `${stateRaw}\n`, stderr: "" };
				return { exitCode: 0, stdout: "", stderr: "" };
			});
			const status = await backend.status(jobId);
			expect(status.state).toBe("failed");
			expect(status.reason?.kind).toBe("executor");
			expect(status.reason?.message).toContain(stateRaw);
		}
	});

	test("terminal-state settle captures exitCode via sacct where available", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "slurm-sacct-1";
		await writeMeta(cwd, {
			jobId,
			backend: "slurm:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "4246:/tmp/stub/slurm-sacct-1",
		});
		const backend = new StubSlurmBackend(cwd, (cmd) => {
			if (cmd.includes("exit.code")) return { exitCode: 0, stdout: "PENDING\n", stderr: "" };
			if (cmd.includes("squeue")) return { exitCode: 0, stdout: "FAILED\n", stderr: "" };
			if (cmd.includes("sacct")) return { exitCode: 0, stdout: "2:0\n", stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const status = await backend.status(jobId);
		expect(backend.commands.some((c) => c.includes("sacct"))).toBe(true);
		expect(status.exitCode).toBe(2); // "2:0" → take the exit segment before the colon
		expect(status.state).toBe("failed");
	});

	test("COMPLETED without exit.code: bounded grace then settles failed/executor (no infinite running)", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "slurm-grace-1";
		await writeMeta(cwd, {
			jobId,
			backend: "slurm:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "4247:/tmp/stub/slurm-grace-1",
		});
		const backend = new StubSlurmBackend(cwd, (cmd) => {
			if (cmd.includes("exit.code")) return { exitCode: 0, stdout: "PENDING\n", stderr: "" };
			if (cmd.includes("squeue")) return { exitCode: 0, stdout: "COMPLETED\n", stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		// the first N-1 rounds stay running (waiting for exit.code within the grace window)
		for (let i = 0; i < SLURM_COMPLETED_GRACE_SCANS - 1; i++) {
			expect((await backend.status(jobId)).state).toBe("running");
		}
		const settled = await backend.status(jobId);
		expect(settled.state).toBe("failed");
		expect(settled.reason?.kind).toBe("executor");
		expect(settled.reason?.message).toContain("COMPLETED");
	});

	test("COMPLETED grace resets when exit.code lands within the window", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "slurm-grace-2";
		await writeMeta(cwd, {
			jobId,
			backend: "slurm:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "4248:/tmp/stub/slurm-grace-2",
		});
		let exitWritten = false;
		const backend = new StubSlurmBackend(cwd, (cmd) => {
			if (cmd.includes("exit.code")) return { exitCode: 0, stdout: exitWritten ? "0\n" : "PENDING\n", stderr: "" };
			if (cmd.includes("squeue")) return { exitCode: 0, stdout: "COMPLETED\n", stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		expect((await backend.status(jobId)).state).toBe("running");
		expect((await backend.status(jobId)).state).toBe("running");
		exitWritten = true;
		const settled = await backend.status(jobId);
		expect(settled.state).toBe("completed");
		expect(settled.exitCode).toBe(0);
	});

	test("cancel after exit.code landed keeps completed and skips scancel", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "slurm-cancel-done";
		await writeMeta(cwd, {
			jobId,
			backend: "slurm:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "4249:/tmp/stub/slurm-cancel-done",
		});
		const backend = new StubSlurmBackend(cwd, (cmd) => {
			if (cmd.includes("exit.code")) return { exitCode: 0, stdout: "0\n", stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		await backend.cancel(jobId);
		const meta = await readMeta(cwd, jobId);
		expect(meta?.state).toBe("completed");
		expect(meta?.exitCode).toBe(0);
		expect(backend.commands.some((c) => c.includes("scancel"))).toBe(false);
	});

	test("parseSlurmHandle splits on FIRST colon only (remoteDir may contain colons)", () => {
		expect(parseSlurmHandle("77:/data/foo:bar/job-1")).toEqual({ slurmId: 77, remoteDir: "/data/foo:bar/job-1" });
		expect(parseSlurmHandle("77:/plain/dir")).toEqual({ slurmId: 77, remoteDir: "/plain/dir" });
		expect(parseSlurmHandle(undefined)).toEqual({ remoteDir: "" });
		expect(parseSlurmHandle("")).toEqual({ remoteDir: "" });
	});

	test("status probes the full colon-containing remoteDir (old split(':') truncated it)", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "slurm-colon-1";
		await writeMeta(cwd, {
			jobId,
			backend: "slurm:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "77:/data/foo:bar/job-1",
		});
		const backend = new StubSlurmBackend(cwd, (cmd) => {
			// only a probe of the full remoteDir gets the exit code; a probe truncated to /data/foo gets PENDING
			if (cmd.includes("cat '/data/foo:bar/job-1/exit.code'")) return { exitCode: 0, stdout: "0\n", stderr: "" };
			return { exitCode: 0, stdout: "PENDING\n", stderr: "" };
		});
		const status = await backend.status(jobId);
		expect(backend.commands[0]).toContain("cat '/data/foo:bar/job-1/exit.code'");
		expect(status.state).toBe("completed");
	});
});

describe("Remote reclaim status sweeps (mock)", () => {
	test("ssh reclaimOrphans sweeps status(): remotely-settled jobs settle, others untouched", async () => {
		const cwd = await tmpWorkdir();
		await writeMeta(cwd, {
			jobId: "ssh-re-1",
			backend: "ssh:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "/tmp/stub/ssh-re-1",
		});
		await writeMeta(cwd, {
			jobId: "ssh-re-2",
			backend: "ssh:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "/tmp/stub/ssh-re-2",
		});
		await writeMeta(cwd, {
			jobId: "ssh-re-3",
			backend: "other-backend",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "/tmp/stub/ssh-re-3",
		});
		const backend = new StubSshBackend(cwd, (cmd) => {
			if (cmd.includes("ssh-re-1/exit.code")) return { exitCode: 0, stdout: "0\n", stderr: "" };
			return { exitCode: 0, stdout: "PENDING\n", stderr: "" };
		});
		const reclaimed = await backend.reclaimOrphans();
		expect(reclaimed).toBe(1);
		expect((await readMeta(cwd, "ssh-re-1"))?.state).toBe("completed");
		expect((await readMeta(cwd, "ssh-re-2"))?.state).toBe("running");
		expect((await readMeta(cwd, "ssh-re-3"))?.state).toBe("running");
	});

	test("slurm reclaimOrphans inherits the sweep (settles via exit.code)", async () => {
		const cwd = await tmpWorkdir();
		await writeMeta(cwd, {
			jobId: "slurm-re-1",
			backend: "slurm:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "500:/tmp/stub/slurm-re-1",
		});
		const backend = new StubSlurmBackend(cwd, (cmd) => {
			if (cmd.includes("exit.code")) return { exitCode: 0, stdout: "2\n", stderr: "" };
			return { exitCode: 0, stdout: "PENDING\n", stderr: "" };
		});
		const reclaimed = await backend.reclaimOrphans();
		expect(reclaimed).toBe(1);
		const meta = await readMeta(cwd, "slurm-re-1");
		expect(meta?.state).toBe("failed");
		expect(meta?.exitCode).toBe(2);
	});

	test("modal reclaimOrphans settles jobs whose exit.code appeared (status sweep)", async () => {
		const cwd = await tmpWorkdir();
		await writeMeta(cwd, {
			jobId: "modal-re-exit",
			backend: "modal",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: String(process.pid), // launcher alive, but exit.code already written → the status sweep settles it
		});
		await Bun.write(join(jobDir(cwd, "modal-re-exit"), "exit.code"), "0");
		const backend = new ModalBackend(cwd);
		const reclaimed = await backend.reclaimOrphans();
		expect(reclaimed).toBe(1);
		expect((await readMeta(cwd, "modal-re-exit"))?.state).toBe("completed");
	});

	test("modal reclaimOrphans reaps vanished launcher: settle failed (stuck-running cure)", async () => {
		const cwd = await tmpWorkdir();
		await writeMeta(cwd, {
			jobId: "modal-re-gone",
			backend: "modal",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "99999999",
		});
		const backend = new ModalBackend(cwd);
		const reclaimed = await backend.reclaimOrphans();
		expect(reclaimed).toBe(1);
		const meta = await readMeta(cwd, "modal-re-gone");
		expect(meta?.state).toBe("failed");
		expect(meta?.reason?.kind).toBe("executor");
		expect(meta?.reason?.message).toContain("launcher");
	});

	test("modal reclaimOrphans leaves alive-launcher jobs running", async () => {
		const cwd = await tmpWorkdir();
		await writeMeta(cwd, {
			jobId: "modal-re-alive",
			backend: "modal",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: String(process.pid),
		});
		const backend = new ModalBackend(cwd);
		const reclaimed = await backend.reclaimOrphans();
		expect(reclaimed).toBe(0);
		expect((await readMeta(cwd, "modal-re-alive"))?.state).toBe("running");
	});
});

describe("Modal exit.code validation (E2)", () => {
	test("empty/partial exit.code is treated as not-yet-written: no NaN settles into meta", async () => {
		const cwd = await tmpWorkdir();
		await writeMeta(cwd, {
			jobId: "modal-partial",
			backend: "modal",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: String(process.pid),
		});
		// empty file = created but not yet written: must not settle (Number("") === 0 mis-settles)
		await Bun.write(join(jobDir(cwd, "modal-partial"), "exit.code"), "");
		const backend = new ModalBackend(cwd);
		const during = await backend.status("modal-partial");
		expect(during.state).toBe("running");
		expect(during.exitCode).toBeUndefined();

		await Bun.write(join(jobDir(cwd, "modal-partial"), "exit.code"), "not-a-number");
		expect((await backend.status("modal-partial")).state).toBe("running");

		await Bun.write(join(jobDir(cwd, "modal-partial"), "exit.code"), "3");
		const settled = await backend.status("modal-partial");
		expect(settled.state).toBe("failed");
		expect(settled.exitCode).toBe(3);
		const meta = await readMeta(cwd, "modal-partial");
		expect(meta?.exitCode).toBe(3); // never null (NaN's JSON form)
	});
});

describe("Modal status() proactive reflow (J1/J3)", () => {
	test("status() settles failed when the launcher died without exit.code — reclaim wording, no restart needed", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "modal-status-gone";
		await writeMeta(cwd, {
			jobId,
			backend: "modal",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "99999999", // launcher pid that cannot be alive; no sandbox part → no modal CLI call
		});
		const backend = new ModalBackend(cwd);
		const status = await backend.status(jobId);
		expect(status.state).toBe("failed");
		expect(status.reason?.kind).toBe("executor");
		expect(status.reason?.message).toContain("modal launcher exited without exit.code");
		expect((await readMeta(cwd, jobId))?.state).toBe("failed");
	});

	test("cancel after exit.code landed keeps the real outcome, not canceled (J3)", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "modal-cancel-done";
		await writeMeta(cwd, {
			jobId,
			backend: "modal",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: String(process.pid), // alive launcher, no sandbox part → the kill path is a no-op anyway
		});
		await Bun.write(join(jobDir(cwd, jobId), "exit.code"), "0");
		const backend = new ModalBackend(cwd);
		await backend.cancel(jobId);
		const meta = await readMeta(cwd, jobId);
		expect(meta?.state).toBe("completed");
		expect(meta?.exitCode).toBe(0);
	});
});

describe("First-claim settlement races (E5: cancel vs poll/watch never overwrite a terminal state)", () => {
	test("ssh cancel during an in-flight status probe waits it out, then settles canceled (never stuck running)", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "ssh-race-1";
		await writeMeta(cwd, {
			jobId,
			backend: "ssh:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "/tmp/stub/ssh-race-1",
		});
		let stateSeenByKill: string | undefined;
		const backend = new StubSshBackend(cwd, async (cmd) => {
			if (cmd.includes("exit.code")) {
				await Bun.sleep(200); // slow probe still holding the settlement claim when cancel arrives
				return { exitCode: 0, stdout: "PENDING\n", stderr: "" };
			}
			if (cmd.includes("pkill")) stateSeenByKill = (await readMeta(cwd, jobId))?.state;
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const pending = backend.status(jobId);
		await Bun.sleep(50);
		await backend.cancel(jobId);
		expect((await pending).state).toBe("running");
		const meta = await readMeta(cwd, jobId);
		expect(meta?.state).toBe("canceled");
		expect(meta?.reason?.kind).toBe("user");
		expect(meta?.reason?.message).toBe("canceled by user"); // plain path keeps the plain user-cancel reason
		expect(stateSeenByKill).toBe("canceled"); // settle-before-kill still holds
	}, 15_000);

	test("ssh cancel arriving after remote completion: the poll's terminal settle wins, cancel never overwrites", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "ssh-race-2";
		await writeMeta(cwd, {
			jobId,
			backend: "ssh:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "/tmp/stub/ssh-race-2",
		});
		const backend = new StubSshBackend(cwd, async (cmd) => {
			if (cmd.includes("exit.code")) {
				await Bun.sleep(150);
				return { exitCode: 0, stdout: "0\n", stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const pending = backend.status(jobId);
		await Bun.sleep(50);
		await backend.cancel(jobId);
		expect((await pending).state).toBe("completed");
		expect((await readMeta(cwd, jobId))?.state).toBe("completed");
		// the remote kill still runs (best-effort, unconditional)
		expect(backend.commands.some((c) => c.includes("kea-run.sh"))).toBe(true);
	}, 15_000);

	test("slurm cancel waits out an in-flight poll chain, then settles canceled", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "slurm-race-1";
		await writeMeta(cwd, {
			jobId,
			backend: "slurm:stub",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "4321:/tmp/stub/slurm-race-1",
		});
		const backend = new StubSlurmBackend(cwd, async (cmd) => {
			if (cmd.includes("exit.code")) {
				await Bun.sleep(150);
				return { exitCode: 0, stdout: "PENDING\n", stderr: "" };
			}
			if (cmd.includes("squeue")) {
				await Bun.sleep(150);
				return { exitCode: 0, stdout: "RUNNING\n", stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const pending = backend.status(jobId);
		await Bun.sleep(50);
		await backend.cancel(jobId);
		expect((await pending).state).toBe("running");
		expect((await readMeta(cwd, jobId))?.state).toBe("canceled");
		expect(backend.commands.some((c) => c.includes("scancel"))).toBe(true);
	}, 15_000);

	test("modal cancel settles canceled idempotently (second cancel no-ops)", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "modal-cancel-1";
		// a real living child as the fake launcher: cancel SIGTERMs it — never this process's own pid
		const proc = Bun.spawn(["sleep", "30"]);
		await writeMeta(cwd, {
			jobId,
			backend: "modal",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: String(proc.pid),
		});
		const backend = new ModalBackend(cwd);
		await backend.cancel(jobId);
		expect((await readMeta(cwd, jobId))?.state).toBe("canceled");
		await backend.cancel(jobId);
		const meta = await readMeta(cwd, jobId);
		expect(meta?.state).toBe("canceled");
		expect(meta?.reason?.kind).toBe("user");
		await proc.exited.catch(() => {}); // the canceled launcher received the SIGTERM
	}, 15_000);

	test("modal cancel kills through the post-probe fresh handle (SBID discovered by the probe, not the stale pre-probe handle)", async () => {
		const cwd = await tmpWorkdir();
		const jobId = "modal-cancel-fresh";
		// a real living child as the launcher so the dead-launcher fallback never fires
		const proc = Bun.spawn(["sleep", "30"]);
		// the probe discovers the sandbox id from launch.log; the pre-probe meta handle has no SBID part
		await writeMeta(cwd, {
			jobId,
			backend: "modal",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: String(proc.pid),
		});
		await Bun.write(join(jobDir(cwd, jobId), "launch.log"), "SBID:sb-fresh-42\n");
		// stub the modal CLI so the test observes which sandbox the cancel path terminates
		const binDir = await mkdtemp(join(tmpdir(), "kea2-modal-bin-"));
		const callsFile = join(binDir, "calls.txt");
		await Bun.write(join(binDir, "modal"), `#!/bin/bash\necho "$@" >> ${shellQuote(callsFile)}\nexit 0\n`);
		await chmod(join(binDir, "modal"), 0o755);
		const prevPath = process.env.PATH;
		process.env.PATH = `${binDir}:${prevPath}`;
		try {
			const backend = new ModalBackend(cwd);
			await backend.cancel(jobId);
			const meta = await readMeta(cwd, jobId);
			expect(meta?.state).toBe("canceled");
			// killing through the pre-probe handle would terminate no sandbox and leak it remotely
			expect(await Bun.file(callsFile).text()).toContain("sandbox terminate sb-fresh-42");
		} finally {
			process.env.PATH = prevPath;
			await proc.exited.catch(() => {}); // the canceled launcher received the SIGTERM
			await rm(binDir, { recursive: true, force: true });
		}
	}, 15_000);
});
