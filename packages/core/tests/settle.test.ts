import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { jobDir, readMeta, writeMeta } from "../src/execution/ledger.ts";
import { SettleGate } from "../src/execution/settle.ts";
import type { JobStatus } from "../src/execution/types.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

async function seed(cwd: string, jobId: string): Promise<void> {
	await writeMeta(cwd, {
		jobId,
		backend: "local",
		state: "running",
		command: "true",
		submittedAt: Date.now(),
	});
}

function canceled(meta: JobStatus): JobStatus {
	return { ...meta, state: "canceled", settledAt: Date.now(), reason: { kind: "user", message: "canceled by user" } };
}

describe("SettleGate first-claim discipline (E5)", () => {
	test("two concurrent settles of the same job: exactly one wins", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-settle-"));
		const jobId = "race-1";
		await seed(workdir, jobId);
		const gate = new SettleGate();
		const outcomes = await Promise.all([gate.settle(workdir, jobId, canceled), gate.settle(workdir, jobId, canceled)]);
		expect(outcomes.filter(Boolean)).toHaveLength(1);
		expect((await readMeta(workdir, jobId))?.state).toBe("canceled");
	}, 15_000);

	test("settling an already-settled job is a no-op", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-settle-"));
		const jobId = "done-1";
		await seed(workdir, jobId);
		const gate = new SettleGate();
		expect(await gate.settle(workdir, jobId, canceled)).toBe(true);
		const before = await readMeta(workdir, jobId);
		expect(await gate.settle(workdir, jobId, canceled)).toBe(false);
		expect(await gate.settle(workdir, jobId, canceled)).toBe(false);
		const after = await readMeta(workdir, jobId);
		expect(after?.settledAt).toBe(before?.settledAt); // never rewritten
	}, 15_000);

	test("write failure releases the claim so a later settler can retry", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-settle-"));
		const jobId = "io-1";
		await seed(workdir, jobId);
		const gate = new SettleGate();

		// make the ledger dir unwritable so the settled write fails (skip when the environment doesn't enforce perms, e.g. root)
		await chmod(jobDir(workdir, jobId), 0o500);
		let blocked = false;
		try {
			const probe = await Bun.file(join(jobDir(workdir, jobId), "meta.json")).exists();
			blocked = probe && !(await gate.settle(workdir, jobId, canceled));
		} finally {
			await chmod(jobDir(workdir, jobId), 0o755);
		}
		if (blocked) {
			// the claim must have been released: a retry after the IO fault succeeds
			expect(await gate.settle(workdir, jobId, canceled)).toBe(true);
			expect((await readMeta(workdir, jobId))?.state).toBe("canceled");
		}
	}, 15_000);

	test("settle waits out an in-flight claim instead of dropping the settlement", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-settle-"));
		const jobId = "wait-1";
		await seed(workdir, jobId);
		const gate = new SettleGate();
		// simulate a status probe holding the settlement mutex
		expect(gate.claim(jobId)).toBe(true);
		const pending = gate.settle(workdir, jobId, canceled, 2_000);
		await Bun.sleep(150);
		gate.release(jobId); // probe finished: still running, claim handed back
		expect(await pending).toBe(true);
		expect((await readMeta(workdir, jobId))?.state).toBe("canceled");
	}, 15_000);

	test("settle gives up after the bounded wait and stays a no-op afterwards", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-settle-"));
		const jobId = "timeout-1";
		await seed(workdir, jobId);
		const gate = new SettleGate();
		expect(gate.claim(jobId)).toBe(true);
		expect(await gate.settle(workdir, jobId, canceled, 100)).toBe(false);
		gate.release(jobId);
		// after the holder released, a later settler still can
		expect(await gate.settle(workdir, jobId, canceled)).toBe(true);
	}, 15_000);

	test("writeUnsettled never overwrites a settled job", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-settle-"));
		const jobId = "transition-1";
		await seed(workdir, jobId);
		const gate = new SettleGate();
		expect(gate.claim(jobId)).toBe(true);
		expect(await gate.writeSettled(workdir, jobId, canceled)).toBe(true);
		gate.release(jobId);
		// a queued→running transition arriving after settlement must be skipped
		const after = await gate.writeUnsettled(workdir, jobId, (meta) => ({ ...meta, state: "running" }));
		expect(after?.state).toBe("canceled");
		expect((await readMeta(workdir, jobId))?.state).toBe("canceled");
	}, 15_000);
});
