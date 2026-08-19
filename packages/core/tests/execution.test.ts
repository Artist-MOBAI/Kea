import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createExecutionEnv } from "../src/env.ts";
import { jobDir, metaPath, readMeta, writeMeta } from "../src/execution/ledger.ts";
import { LocalBackend } from "../src/execution/local.ts";
import type { JobStatus } from "../src/execution/types.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

async function makeBackend() {
	workdir = await mkdtemp(join(tmpdir(), "kea2-exec-"));
	const { env } = await createExecutionEnv(workdir);
	return { cwd: workdir, backend: new LocalBackend(env, workdir) };
}

async function waitSettled(backend: LocalBackend, jobId: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const status = await backend.status(jobId);
		if (["completed", "failed", "canceled", "preempted"].includes(status.state)) return;
		await Bun.sleep(50);
	}
	throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms`);
}

describe("LocalBackend lifecycle (M4)", () => {
	test("echo command completes with stdout captured", async () => {
		const { backend } = await makeBackend();
		const { jobId } = await backend.submit({ command: "echo kea-m4-ok" });
		await waitSettled(backend, jobId);
		const result = await backend.result(jobId);
		expect(result.state).toBe("completed");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("kea-m4-ok");
	}, 15_000);

	test("non-zero exit → failed with executor reason", async () => {
		const { backend } = await makeBackend();
		const { jobId } = await backend.submit({ command: "exit 3" });
		await waitSettled(backend, jobId);
		const status = await backend.status(jobId);
		expect(status.state).toBe("failed");
		expect(status.exitCode).toBe(3);
		expect(status.reason?.kind).toBe("executor");
	}, 15_000);

	test("cancel settles as canceled", async () => {
		const { backend } = await makeBackend();
		const { jobId } = await backend.submit({ command: "sleep 30", timeoutMs: 60_000 });
		await Bun.sleep(200);
		await backend.cancel(jobId);
		const status = await backend.status(jobId);
		expect(status.state).toBe("canceled");
		expect(status.reason?.kind).toBe("user");
	}, 15_000);

	test("timeout settles as failed/timeout", async () => {
		const { backend } = await makeBackend();
		const { jobId } = await backend.submit({ command: "sleep 30", timeoutMs: 500 });
		await waitSettled(backend, jobId);
		const status = await backend.status(jobId);
		expect(status.state).toBe("failed");
		expect(status.reason?.kind).toBe("timeout");
	}, 15_000);

	test("reclaimOrphans marks dead running jobs preempted", async () => {
		const { cwd, backend } = await makeBackend();
		await writeMeta(cwd, {
			jobId: "orphan-1",
			backend: "local",
			state: "running",
			command: "sleep 999",
			submittedAt: Date.now() - 60_000,
			handle: "99999999",
		});
		const reclaimed = await backend.reclaimOrphans();
		expect(reclaimed).toBe(1);
		const status = await backend.status("orphan-1");
		expect(status.state).toBe("preempted");
		expect(await Bun.file(metaPath(cwd, "orphan-1")).exists()).toBe(true);
	}, 15_000);

	test("cancel of orphaned-but-alive job settles canceled and kills the pid", async () => {
		const { cwd, backend } = await makeBackend();
		// Simulate crash restart: the process is alive, but the new backend's active map has only meta, not it
		const proc = Bun.spawn(["sleep", "30"]);
		const pid = proc.pid;
		await writeMeta(cwd, {
			jobId: "orphan-alive",
			backend: "local",
			state: "running",
			command: "sleep 30",
			submittedAt: Date.now(),
			handle: String(pid),
		});
		await backend.cancel("orphan-alive");
		const status = await backend.status("orphan-alive");
		expect(status.state).toBe("canceled");
		expect(status.reason?.kind).toBe("user");
		await proc.exited;
		const alive = (() => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		})();
		expect(alive).toBe(false);
	}, 15_000);
});

describe("writeMeta atomicity (M4)", () => {
	test("meta.json parseable after write, no tmp residue, overwrite settles", async () => {
		const { cwd } = await makeBackend();
		const status: JobStatus = {
			jobId: "atomic-1",
			backend: "local",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
		};
		await writeMeta(cwd, status);
		expect(await readMeta(cwd, "atomic-1")).toEqual(status);
		await writeMeta(cwd, { ...status, state: "completed", settledAt: Date.now(), exitCode: 0 });
		expect((await readMeta(cwd, "atomic-1"))?.state).toBe("completed");
		const entries = await readdir(jobDir(cwd, "atomic-1"));
		expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
	}, 15_000);

	test("concurrent settles of same job: unique tmp names, all succeed, no residue", async () => {
		const { cwd } = await makeBackend();
		const base: JobStatus = {
			jobId: "race-1",
			backend: "local",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
		};
		await writeMeta(cwd, base);
		// concurrent settles of the same job (timeout racing cancel) must not collide on one tmp name
		await Promise.all(
			Array.from({ length: 32 }, (_, i) =>
				writeMeta(cwd, { ...base, state: "failed", exitCode: i, settledAt: Date.now(), reason: { kind: "executor" } }),
			),
		);
		const meta = await readMeta(cwd, "race-1");
		expect(meta?.state).toBe("failed");
		const entries = await readdir(jobDir(cwd, "race-1"));
		expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
	}, 15_000);

	test("ledger source uses tmp + rename, never writes meta.json directly", async () => {
		const src = await Bun.file(join(import.meta.dirname, "..", "src", "execution", "ledger.ts")).text();
		expect(src).not.toContain("Bun.write(metaPath");
		expect(src).toContain("rename(tmp, target)");
	});
});

describe("LocalBackend process-group kill (M4)", () => {
	function groupMembers(pgid: number): string {
		return Bun.spawnSync(["bash", "-c", `ps ax -o pgid=,comm= | awk '$1==${pgid}'`])
			.stdout.toString()
			.trim();
	}

	async function waitGroupGone(pgid: number, timeoutMs = 5000): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		let survivors = groupMembers(pgid);
		while (survivors !== "" && Date.now() < deadline) {
			await Bun.sleep(100);
			survivors = groupMembers(pgid);
		}
		return survivors;
	}

	test("timeout kills the whole process group — children do not survive", async () => {
		const { backend } = await makeBackend();
		const { jobId } = await backend.submit({ command: "sleep 30 & sleep 30 & wait", timeoutMs: 800 });
		await waitSettled(backend, jobId);
		const status = await backend.status(jobId);
		expect(status.state).toBe("failed");
		expect(status.reason?.kind).toBe("timeout");
		// detached start → pgid === shell pid, so the handle identifies the whole group
		expect(await waitGroupGone(Number(status.handle))).toBe("");
	}, 20_000);

	test("cancel kills the whole process group — children do not survive", async () => {
		const { backend } = await makeBackend();
		const { jobId } = await backend.submit({ command: "sleep 30 & wait", timeoutMs: 60_000 });
		await Bun.sleep(300);
		await backend.cancel(jobId);
		const status = await backend.status(jobId);
		expect(status.state).toBe("canceled");
		expect(await waitGroupGone(Number(status.handle))).toBe("");
	}, 20_000);

	test("reclaimOrphans re-attaches watch: alive orphan settles when its process exits", async () => {
		const { cwd, backend } = await makeBackend();
		// crash-restart simulation: process alive, meta unsettled, the new backend's active table has no entry
		const proc = Bun.spawn(["bash", "-c", "sleep 0.5"], { detached: true });
		await writeMeta(cwd, {
			jobId: "orphan-reattach",
			backend: "local",
			state: "running",
			command: "sleep 0.5",
			submittedAt: Date.now(),
			handle: String(proc.pid),
			timeoutMs: 60_000,
		});
		const reclaimed = await backend.reclaimOrphans();
		expect(reclaimed).toBe(1);
		// the liveness poll must settle a live orphan fail-closed once it exits (exit code already lost)
		const deadline = Date.now() + 10_000;
		let status = await backend.status("orphan-reattach");
		while (status.state === "running" && Date.now() < deadline) {
			await Bun.sleep(100);
			status = await backend.status("orphan-reattach");
		}
		expect(status.state).toBe("failed");
		expect(status.reason?.kind).toBe("system");
	}, 20_000);

	test("reclaimOrphans times out alive orphan by the persisted original timeout", async () => {
		const { cwd, backend } = await makeBackend();
		const proc = Bun.spawn(["sleep", "30"], { detached: true });
		await writeMeta(cwd, {
			jobId: "orphan-timeout",
			backend: "local",
			state: "running",
			command: "sleep 30",
			submittedAt: Date.now() - 1_500, // original 2s timeout already mostly elapsed → after re-attach, ~1s (lower bound) triggers
			handle: String(proc.pid),
			timeoutMs: 2_000,
		});
		await backend.reclaimOrphans();
		const deadline = Date.now() + 8_000;
		let status = await backend.status("orphan-timeout");
		while (status.state === "running" && Date.now() < deadline) {
			await Bun.sleep(100);
			status = await backend.status("orphan-timeout");
		}
		expect(status.state).toBe("failed");
		expect(status.reason?.kind).toBe("timeout");
		await proc.exited.catch(() => {});
	}, 20_000);
});

describe("ensurePythonEnv pip drain (M4)", () => {
	const hasPython = (() => {
		try {
			return Bun.spawnSync(["python3", "--version"]).exitCode === 0;
		} catch {
			return false;
		}
	})();

	test.skipIf(!hasPython)(
		"verbose pip stderr >64KB does not deadlock (drained concurrently)",
		async () => {
			// the fake pip floods 300KB to stderr (far beyond the pipe buffer): stderr must be drained
			// concurrently or pip blocks writing the pipe and deadlocks
			const dir = await mkdtemp(join(tmpdir(), "kea2-pyenv-"));
			const fakeRoot = join(dir, "fakepip");
			await Bun.write(join(fakeRoot, "pip", "__init__.py"), "");
			await Bun.write(
				join(fakeRoot, "pip", "__main__.py"),
				[
					"import sys",
					'if "install" in sys.argv:',
					'    sys.stderr.write("x" * 300000)',
					"    sys.stderr.flush()",
					"    sys.exit(0)",
					"sys.exit(0)",
				].join("\n"),
			);
			const prev = process.env.PYTHONPATH;
			process.env.PYTHONPATH = fakeRoot;
			try {
				const { ensurePythonEnv } = await import("../src/execution/python-env.ts");
				const env = await ensurePythonEnv({
					cwd: dir,
					name: "drain",
					requirements: ["anything"],
					pythonBinary: "python3",
					venvTimeoutMs: 90_000,
					pipTimeoutMs: 10_000,
				});
				expect(env.created).toBe(true);
			} finally {
				if (prev === undefined) delete process.env.PYTHONPATH;
				else process.env.PYTHONPATH = prev;
				await rm(dir, { recursive: true, force: true });
			}
		},
		180_000,
	);
});
