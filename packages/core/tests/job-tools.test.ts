import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createExecutionEnv } from "../src/env.ts";
import { BackendRegistry } from "../src/execution/backend.ts";
import { HumanBackend } from "../src/execution/human.ts";
import { stdoutPath, writeMeta } from "../src/execution/ledger.ts";
import { LocalBackend } from "../src/execution/local.ts";
import { createJobTools, type JobToolsContext } from "../src/execution/tools.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

type ToolResult = { content: Array<{ type: string; text: string }>; details: { count?: number }; isError?: boolean };

function textOf(res: ToolResult): string {
	return res.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

async function makeCtx(): Promise<{ ctx: JobToolsContext; cwd: string; local: LocalBackend }> {
	workdir = await mkdtemp(join(tmpdir(), "kea2-jobs-"));
	const { env } = await createExecutionEnv(workdir);
	const local = new LocalBackend(env, workdir);
	const human = new HumanBackend(workdir);
	const registry = new BackendRegistry(workdir);
	registry.register(local);
	registry.register(human);
	const ctx: JobToolsContext = { registry, human, cwd: workdir };
	return { ctx, cwd: workdir, local };
}

function toolsOf(ctx: JobToolsContext) {
	const tools = createJobTools(ctx);
	const list = tools.find((t) => t.name === "job_list") as {
		execute: (id: string, params: { state?: string }) => Promise<ToolResult>;
	};
	const status = tools.find((t) => t.name === "job_status") as {
		execute: (id: string, params: { job_id: string }) => Promise<ToolResult>;
	};
	return { list, status };
}

describe("job_list (E4)", () => {
	test("lists all jobs with id/backend/state/label/created; optional state filter", async () => {
		const { ctx, cwd, local } = await makeCtx();
		const { list } = toolsOf(ctx);
		const { jobId } = await local.submit({ command: "sleep 2", label: "live-run" });
		await writeMeta(cwd, {
			jobId: "remote-done",
			backend: "ssh:gone-host",
			state: "completed",
			command: "true",
			submittedAt: Date.now() - 5_000,
			settledAt: Date.now(),
			exitCode: 0,
		});
		await writeMeta(cwd, {
			jobId: "remote-run",
			backend: "ssh:gone-host",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
		});

		const all = (await list.execute("id", {})) as ToolResult;
		const allText = textOf(all);
		expect(all.details.count).toBe(3);
		expect(allText).toContain(jobId);
		expect(allText).toContain("backend=local state=running label=live-run");
		expect(allText).toContain("remote-done backend=ssh:gone-host state=completed");
		expect(allText).toContain("created="); // created timestamp present on every row

		const running = (await list.execute("id", { state: "running" })) as ToolResult;
		expect(running.details.count).toBe(2);
		expect(textOf(running)).toContain(jobId);
		expect(textOf(running)).toContain("remote-run");
		expect(textOf(running)).not.toContain("remote-done");

		const empty = (await list.execute("id", { state: "awaiting_human" })) as ToolResult;
		expect(empty.details.count).toBe(0);
		expect(textOf(empty)).toContain("no jobs in state");

		const invalid = (await list.execute("id", { state: "exploded" })) as ToolResult;
		expect(invalid.isError).toBe(true);
		expect(textOf(invalid)).toContain("Unknown state");

		await local.cancel(jobId).catch(() => {});
	}, 15_000);

	test("empty workspace: no jobs", async () => {
		const { ctx } = await makeCtx();
		const { list } = toolsOf(ctx);
		const res = (await list.execute("id", {})) as ToolResult;
		expect(textOf(res)).toBe("no jobs");
	}, 15_000);
});

describe("job_status running-state logs (E4)", () => {
	test("running local job returns the streamed stdout/stderr tail", async () => {
		const { ctx, cwd } = await makeCtx();
		const { status } = toolsOf(ctx);
		await writeMeta(cwd, {
			jobId: "run-tail-1",
			backend: "local",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
		});
		await Bun.write(stdoutPath(cwd, "run-tail-1"), "early line\nlatest streamed line\n");
		const res = (await status.execute("id", { job_id: "run-tail-1" })) as ToolResult;
		const text = textOf(res);
		expect(text).toContain("state=running");
		expect(text).toContain("--- stdout (tail, streaming) ---");
		expect(text).toContain("latest streamed line");
	}, 15_000);

	test("running remote job reports that logs stream on the backend host", async () => {
		const { ctx, cwd } = await makeCtx();
		const { status } = toolsOf(ctx);
		await writeMeta(cwd, {
			jobId: "run-tail-2",
			backend: "human",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
		});
		const res = (await status.execute("id", { job_id: "run-tail-2" })) as ToolResult;
		const text = textOf(res);
		expect(text).toContain("state=running");
		expect(text).toContain("logs stream on the backend host");
		expect(text).not.toContain("streaming) ---");
	}, 15_000);
});

describe("job_status unregistered backend (J4)", () => {
	test("meta exists but its backend is not registered: distinct error naming the backend and the artifacts", async () => {
		const { ctx, cwd } = await makeCtx();
		const { status } = toolsOf(ctx);
		await writeMeta(cwd, {
			jobId: "gone-backend-1",
			backend: "ssh:gone-host",
			state: "running",
			command: "true",
			submittedAt: Date.now(),
			handle: "/remote/gone-backend-1",
		});
		const res = (await status.execute("id", { job_id: "gone-backend-1" })) as ToolResult;
		expect(res.isError).toBe(true);
		const text = textOf(res);
		expect(text).toContain('ran on backend "ssh:gone-host"');
		expect(text).toContain("not registered in this workspace");
		expect(text).toContain(".kea/jobs/gone-backend-1/meta.json");
		expect(text).not.toContain("Unknown job");
	}, 15_000);

	test("missing meta is still the unknown-job error", async () => {
		const { ctx } = await makeCtx();
		const { status } = toolsOf(ctx);
		const res = (await status.execute("id", { job_id: "never-existed" })) as ToolResult;
		expect(res.isError).toBe(true);
		expect(textOf(res)).toContain("Unknown job never-existed");
	}, 15_000);
});

describe("job tools three-part description contract pin (stable model-visible text)", () => {
	test("meta ledger sole state source / settle before kill / running log tail contract lines verbatim", async () => {
		const { ctx } = await makeCtx();
		const tools = createJobTools(ctx);
		const desc = (name: string) => (tools.find((t) => t.name === name) as { description: string }).description;
		// the real contracts, as the code behaves: meta.json is the state source, cancel settles first
		expect(desc("run_experiment")).toContain("the single source of truth for its state");
		expect(desc("job_list")).toContain("scans the meta.json ledger only");
		expect(desc("job_status")).toContain("single source of truth for the state");
		expect(desc("job_status")).toContain("tail of the already-flushed on-disk logs");
		expect(desc("job_cancel")).toContain("The ledger is settled before the process is killed");
		expect(desc("submit_experiment_result")).toContain("call this only for jobs on the human backend");
		expect(desc("run_experiment")).toContain("poll it with job_status");
		expect(desc("job_cancel")).toContain("confirm the final state with job_status");
	});
});
