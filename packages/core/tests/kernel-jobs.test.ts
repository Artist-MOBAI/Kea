import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, test } from "vitest";
import { createKernel } from "../src/kernel.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

async function setup() {
	workdir = await mkdtemp(join(tmpdir(), "kea2-kjobs-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const m = faux.getModel();
	return { faux, models, spec: `${m.provider}/${m.id}` };
}

describe("kernel job integration (M4)", () => {
	test("run_experiment submits to local backend and job_status reports completion", async () => {
		const { faux, models, spec } = await setup();
		const kernel = await createKernel({ cwd: workdir, models, model: spec, permissionMode: "auto" });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("run_experiment", { command: "echo kea-job-ok", backend: "local" })]),
			fauxAssistantMessage("submitted"),
		]);
		await kernel.prompt("run the experiment");
		await kernel.agent.waitForIdle();

		let text = JSON.stringify(kernel.agent.state.messages);
		expect(text).toContain("submitted to backend");

		const jobId = /Job ([0-9a-f-]{36}) submitted/.exec(text)?.[1];
		expect(jobId).toBeTruthy();
		const deadline = Date.now() + 10_000;
		let state = "";
		while (Date.now() < deadline) {
			state = (await kernel.jobs.status(jobId as string)).state;
			if (state === "completed") break;
			await Bun.sleep(50);
		}
		expect(state).toBe("completed");

		faux.appendResponses([
			fauxAssistantMessage([fauxToolCall("job_status", { job_id: jobId })]),
			fauxAssistantMessage("done"),
		]);
		await kernel.prompt("check status");
		await kernel.agent.waitForIdle();
		text = JSON.stringify(kernel.agent.state.messages);
		expect(text).toContain("state=completed");
		expect(text).toContain("kea-job-ok");
		await kernel.close();
	}, 30_000);

	test("concurrent-jobs budget rejects extra run_experiment submits", async () => {
		const { faux, models, spec } = await setup();
		const kernel = await createKernel({
			cwd: workdir,
			models,
			model: spec,
			permissionMode: "auto",
			budget: { concurrentJobs: 1 },
		});
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("run_experiment", { command: "sleep 5", backend: "local" }),
				fauxToolCall("run_experiment", { command: "sleep 5", backend: "local" }),
			]),
			fauxAssistantMessage("done"),
		]);
		await kernel.prompt("start two experiments");
		await kernel.agent.waitForIdle();

		const text = JSON.stringify(kernel.agent.state.messages);
		expect(text).toContain("submitted to backend");
		expect(text).toContain("Rejected:");
		expect(text).toContain("concurrent job budget exhausted");
		expect(kernel.jobs.activeCount()).toBe(1);
		await kernel.jobs.cancelAll();
		await kernel.close();
	}, 30_000);
});
