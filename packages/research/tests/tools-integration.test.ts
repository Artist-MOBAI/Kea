import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createExecutionEnv, createKernel, MemoryStore } from "@kea/core";
import { afterAll, describe, expect, test } from "vitest";
import { loadContract } from "../src/evaluator.ts";
import { Journal } from "../src/journal.ts";
import { loadMobai } from "../src/mobai.ts";
import { createResearchTools } from "../src/tools.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

async function makeKernel() {
	workdir = await mkdtemp(join(tmpdir(), "kea2-rt-"));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const { env } = await createExecutionEnv(workdir);
	const journal = new Journal(workdir);
	const memory = new MemoryStore(workdir);
	// check_goal permission gate: the tool is created before the kernel, so bind it lazily via a holder (fail-closed by default)
	let mobaiGate: ((cmd: string) => "approve" | "deny" | "ask") | undefined;
	const kernel = await createKernel({
		cwd: workdir,
		models,
		model: `${model.provider}/${model.id}`,
		permissionMode: "auto",
		extraTools: createResearchTools({
			cwd: workdir,
			env,
			models,
			getModel: () => model,
			journal,
			memory,
			reviewMobaiCommand: (cmd: string) => mobaiGate?.(cmd) ?? "ask",
		}),
	});
	mobaiGate = (cmd: string) => kernel.reviewMobaiCommand(cmd);
	return { faux, kernel, journal };
}

describe("research tools integration (M3)", () => {
	test("define_evaluator freezes a versioned contract; evaluate_solution runs the variance gate", async () => {
		const { faux, kernel, journal } = await makeKernel();
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("define_evaluator", {
					name: "demo",
					eval_cmd: 'echo "METRIC score=0.7"',
					metric_name: "score",
					direction: "maximize",
					seeds: [0, 1],
				}),
			]),
			fauxAssistantMessage([fauxToolCall("evaluate_solution", { evaluator: "demo" })]),
			fauxAssistantMessage("done"),
		]);

		await kernel.prompt("freeze the evaluator and evaluate");
		await kernel.agent.waitForIdle();

		const serialized = JSON.stringify(kernel.agent.state.messages);
		expect(serialized).toContain("Frozen evaluator");
		expect(serialized).toContain("demo");
		expect(serialized).toContain("mean=0.700000");
		expect(serialized).toContain("variance gate: PASS");

		expect((await loadContract(workdir, "demo"))?.version).toBe(1);
		expect(journal.list({ type: "evaluator_frozen" })).toHaveLength(1);
		expect(journal.list({ type: "run_recorded" })).toHaveLength(1);
	}, 30_000);

	test("start_goal + check_goal: machine sets complete", async () => {
		const { faux, kernel } = await makeKernel();
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("start_goal", {
					objective: "produce a metric file",
					criteria: [
						{
							description: "result file exists with METRIC",
							check: "command",
							command: "echo 'METRIC score=1' > result.txt && echo written",
							expect_exit: 0,
							expect_stdout_contains: "written",
						},
					],
				}),
			]),
			fauxAssistantMessage("mobai defined"),
		]);
		await kernel.prompt("define the mobai");
		await kernel.agent.waitForIdle();
		expect((await loadMobai(workdir))?.status).toBe("active");

		faux.appendResponses([fauxAssistantMessage([fauxToolCall("check_goal", {})]), fauxAssistantMessage("checked")]);
		await kernel.prompt("check it");
		await kernel.agent.waitForIdle();

		expect((await loadMobai(workdir))?.status).toBe("complete");
		const text = JSON.stringify(kernel.agent.state.messages);
		expect(text).toContain("✓");
		expect(text).toContain("objective status: complete");
	}, 30_000);

	test("log_research_gap + journal_recall round-trip (FTS5)", async () => {
		const { faux, kernel } = await makeKernel();
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("log_research_gap", {
					statement: "no SPR model for skutterudite filling fractions",
					track: "spr",
					formalizable: true,
					tension: "reported zT values disagree beyond measurement error",
					citations: ["10.1000/demo"],
				}),
			]),
			fauxAssistantMessage([fauxToolCall("journal_recall", { query: "skutterudite filling" })]),
			fauxAssistantMessage("done"),
		]);
		await kernel.prompt("log the gap and recall it");
		await kernel.agent.waitForIdle();

		const text = JSON.stringify(kernel.agent.state.messages);
		expect(text).toContain("Logged gap gap-");
		expect(text).toContain("skutterudite filling fractions");
	}, 30_000);

	test("verify_claim fails closed when the verifier model errors out", async () => {
		const { faux, kernel } = await makeKernel();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("verify_claim", { claim: "x improves y", evidence: "none" })]),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
			fauxAssistantMessage("done"),
		]);
		await kernel.prompt("verify this claim");
		await kernel.agent.waitForIdle();

		const text = JSON.stringify(kernel.agent.state.messages);
		expect(text).toContain("REFUTED");
		expect(text).toContain("verifier invocation failed");
	}, 30_000);
});

describe("evaluate_solution noise gate: machine-pinned baseline (reward-hacking defense)", () => {
	const textOf = (r: { content: unknown[] }): string => {
		const t = (r.content[0] as { text?: unknown } | undefined)?.text;
		return typeof t === "string" ? t : "";
	};

	async function makeTools() {
		workdir = await mkdtemp(join(tmpdir(), "kea2-noise-"));
		const { env } = await createExecutionEnv(workdir);
		const journal = new Journal(workdir);
		const models = createModels();
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const memory = new MemoryStore(workdir);
		const tools = createResearchTools({
			cwd: workdir,
			env,
			models,
			getModel: () => model,
			journal,
			memory,
			// Isolated unit test has no kernel policy chain: the eval_cmd gate is released (auto semantics), testing only the noise gate logic
			reviewEvalCommand: () => "approve",
		});
		const define = tools.find((t) => t.name === "define_evaluator");
		const evaluate = tools.find((t) => t.name === "evaluate_solution");
		if (!define || !evaluate) throw new Error("tools missing");
		return { journal, define, evaluate };
	}

	test("run_recorded records per-seed values and run_id; baseline_run is machine-pinned", async () => {
		const { journal, define, evaluate } = await makeTools();
		try {
			await define.execute("c1", {
				name: "demo",
				eval_cmd: 'echo "METRIC score=0.7"',
				metric_name: "score",
				direction: "maximize",
				seeds: [0, 1],
			});
			const runA = await evaluate.execute("c2", { evaluator: "demo" });
			expect(textOf(runA)).toContain("run_id=");
			const runIdA = runA.details.runId as string;
			expect(typeof runIdA).toBe("string");

			const recorded = journal.list({ type: "run_recorded" });
			const payload = recorded[0]?.payload as { values?: number[]; seeds?: number[]; runId?: string };
			expect(payload.values).toEqual([0.7, 0.7]);
			expect(payload.seeds).toEqual([0, 1]);
			expect(payload.runId).toBe(runIdA);

			// Second run references the first run's run_id: machine-pinned gate
			const runB = await evaluate.execute("c3", { evaluator: "demo", baseline_run: runIdA });
			expect(textOf(runB)).toContain(`noise gate vs recorded run ${runIdA} (machine-pinned)`);
			expect(textOf(runB)).toContain("noise"); // identical values = noise (not improvement/regression)
		} finally {
			journal.close();
			await rm(workdir, { recursive: true, force: true });
		}
	}, 30_000);

	test("self-reported baseline explicitly degrades to NOT machine-pinned; unknown run_id is not accepted", async () => {
		const { journal, define, evaluate } = await makeTools();
		try {
			await define.execute("c1", {
				name: "demo",
				eval_cmd: 'echo "METRIC score=0.7"',
				metric_name: "score",
				direction: "maximize",
				seeds: [0, 1],
			});
			const selfReported = await evaluate.execute("c2", { evaluator: "demo", baseline: [0.9, 0.9] });
			expect(textOf(selfReported)).toContain("self-reported baseline (NOT machine-pinned)");

			const bogusRun = await evaluate.execute("c3", { evaluator: "demo", baseline_run: "no-such-run" });
			expect(textOf(bogusRun)).toContain('no recorded run "no-such-run"');
			expect(textOf(bogusRun)).not.toContain("machine-pinned");
		} finally {
			journal.close();
			await rm(workdir, { recursive: true, force: true });
		}
	}, 30_000);

	test("define_evaluator rejects an invalid metric_name and <2 seeds", async () => {
		const { journal, define } = await makeTools();
		try {
			await expect(
				define.execute("c1", {
					name: "badmetric",
					eval_cmd: 'echo "METRIC score=1"',
					metric_name: "1 not-an-identifier",
					direction: "maximize",
					seeds: [0, 1],
				}),
			).rejects.toThrow(/must match \[A-Za-z_\]\[A-Za-z0-9_\]\*/);

			await expect(
				define.execute("c2", {
					name: "badseeds",
					eval_cmd: 'echo "METRIC score=1"',
					metric_name: "score",
					direction: "maximize",
					seeds: [0],
				}),
			).rejects.toThrow(/at least 2 seeds/);
		} finally {
			journal.close();
			await rm(workdir, { recursive: true, force: true });
		}
	}, 30_000);
});
