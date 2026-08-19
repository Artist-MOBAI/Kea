import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { HumanBackend } from "../src/execution/human.ts";
import { jobDir, metaPath } from "../src/execution/ledger.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

describe("HumanBackend (M4)", () => {
	test("submit writes instructions and parks in awaiting_human", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-human-"));
		const backend = new HumanBackend(workdir);
		const { jobId } = await backend.submit({ command: "measure lattice constant of sample X", label: "xrd" });
		const status = await backend.status(jobId);
		expect(status.state).toBe("awaiting_human");
		const instructions = await Bun.file(join(jobDir(workdir, jobId), "instructions.md")).text();
		expect(instructions).toContain("measure lattice constant");
		expect(instructions).toContain("result.json");
	});

	test("reportResult settles with METRIC lines in stdout", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-human-"));
		const backend = new HumanBackend(workdir);
		const { jobId } = await backend.submit({ command: "run the titration" });
		const settled = await backend.reportResult(jobId, { success: true, notes: "done", metrics: { yield: 0.42 } });
		expect(settled.state).toBe("completed");
		const result = await backend.result(jobId);
		expect(result.stdout).toContain("METRIC yield=0.42");
		expect(result.stdout).toContain("done");
	});

	test("double report idempotent: second call returns existing settled meta, no throw", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-human-"));
		const backend = new HumanBackend(workdir);
		const { jobId } = await backend.submit({ command: "x" });
		const first = await backend.reportResult(jobId, { success: true });
		expect(first.state).toBe("completed");
		// Concurrent poll race: a second settle returns the existing meta (first settle wins) instead of throwing "already settled"
		const second = await backend.reportResult(jobId, { success: false });
		expect(second.state).toBe("completed");
		expect((await backend.status(jobId)).state).toBe("completed");
	});

	test("concurrent status() polls both settle without racing to 'already settled'", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-human-"));
		const backend = new HumanBackend(workdir);
		const { jobId } = await backend.submit({ command: "x" });
		await Bun.write(join(jobDir(workdir, jobId), "result.json"), JSON.stringify({ success: true, metrics: { t: 1 } }));
		// Old impl: two concurrent status() calls both enter reportResult; the later one re-reads meta, sees it settled, then throws
		const [a, b] = await Promise.all([backend.status(jobId), backend.status(jobId)]);
		expect(a.state).toBe("completed");
		expect(b.state).toBe("completed");
	});

	test("out-of-band result.json settles on next status poll", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-human-"));
		const backend = new HumanBackend(workdir);
		const { jobId } = await backend.submit({ command: "x" });
		await Bun.write(join(jobDir(workdir, jobId), "result.json"), JSON.stringify({ success: true, metrics: { t: 1 } }));
		const status = await backend.status(jobId);
		expect(status.state).toBe("completed");
	});

	test("cancel only allowed while awaiting", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-human-"));
		const backend = new HumanBackend(workdir);
		const { jobId } = await backend.submit({ command: "x" });
		await backend.cancel(jobId);
		expect((await backend.status(jobId)).state).toBe("canceled");
		await expect(backend.cancel(jobId)).rejects.toThrow();
	});

	test("repeat poll with unchanged lastError does NOT rewrite meta.json", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-human-"));
		const backend = new HumanBackend(workdir);
		const { jobId } = await backend.submit({ command: "x" });
		await Bun.write(join(jobDir(workdir, jobId), "result.json"), "{ broken");

		const first = await backend.status(jobId);
		expect(first.lastError).toContain("result.json invalid");
		const path = metaPath(workdir, jobId);
		const mtimeBefore = (await stat(path)).mtimeMs;
		await Bun.sleep(30);

		// Old impl rewrote meta on every poll, so concurrent polls raced on the same file; must not rewrite when lastError is unchanged
		const second = await backend.status(jobId);
		expect(second.lastError).toBe(first.lastError);
		expect((await stat(path)).mtimeMs).toBe(mtimeBefore);
	});

	test("malformed result.json (broken JSON): no settle, error written to meta.lastError and visible on poll", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-human-"));
		const backend = new HumanBackend(workdir);
		const { jobId } = await backend.submit({ command: "x" });
		await Bun.write(join(jobDir(workdir, jobId), "result.json"), "{ not json");

		const status = await backend.status(jobId);
		expect(status.state).toBe("awaiting_human");
		expect(status.lastError).toContain("result.json invalid");
		const again = await backend.status(jobId);
		expect(again.state).toBe("awaiting_human");
		expect(again.lastError).toContain("result.json invalid");
	});

	test("schema-invalid result.json (missing success / non-numeric metrics): no settle", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-human-"));
		const backend = new HumanBackend(workdir);
		const { jobId } = await backend.submit({ command: "x" });

		await Bun.write(join(jobDir(workdir, jobId), "result.json"), JSON.stringify({ notes: "no success field" }));
		let status = await backend.status(jobId);
		expect(status.state).toBe("awaiting_human");
		expect(status.lastError).toContain("success");

		await Bun.write(
			join(jobDir(workdir, jobId), "result.json"),
			JSON.stringify({ success: true, metrics: { yield: "high" } }),
		);
		status = await backend.status(jobId);
		expect(status.state).toBe("awaiting_human");
		expect(status.lastError).toContain("metrics");
	});

	test("repaired result.json settles normally and clears lastError", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-human-"));
		const backend = new HumanBackend(workdir);
		const { jobId } = await backend.submit({ command: "x" });
		await Bun.write(join(jobDir(workdir, jobId), "result.json"), "{ broken");
		expect((await backend.status(jobId)).state).toBe("awaiting_human");

		await Bun.write(join(jobDir(workdir, jobId), "result.json"), JSON.stringify({ success: true, metrics: { t: 1 } }));
		const settled = await backend.status(jobId);
		expect(settled.state).toBe("completed");
		expect(settled.lastError).toBeUndefined();
		const result = await backend.result(jobId);
		expect(result.stdout).toContain("METRIC t=1");
	});
});
