import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createKernel, type Kernel } from "@kea/core";
import { afterAll, describe, expect, test } from "vitest";
import { runScienceLoop, scienceContinuationPrompt, scienceSeedPrompt } from "../src/headless/science.ts";
import { makeTempDir, removeTempDir } from "./helpers/temp-dir.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await removeTempDir(workdir);
});

async function setup(
	respond: (faux: ReturnType<typeof fauxProvider>) => void,
	extraTools: AgentTool[] = [],
): Promise<{ kernel: Kernel; faux: ReturnType<typeof fauxProvider> }> {
	workdir = await makeTempDir("kea2-scienceloop-");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const m = faux.getModel();
	respond(faux);
	const kernel = await createKernel({
		cwd: workdir,
		models,
		model: `${m.provider}/${m.id}`,
		permissionMode: "auto",
		headless: true,
		extraTools,
	});
	return { kernel, faux };
}

describe("science prompts", () => {
	test("seed prompt guides factor extraction + honest measurement + journaling + submit", () => {
		const text = scienceSeedPrompt("predict yeast proteome");
		expect(text).toContain("science_plan");
		expect(text).toContain("critical factors");
		expect(text).toContain("autoresearch");
		expect(text).toContain("journal");
		expect(text).toContain("next_hypotheses");
		expect(text).toContain("submit_science_plan");
	});

	test("continuation prompt anti-abandonment + pivot + submit", () => {
		const text = scienceContinuationPrompt({ round: 3, maxRounds: 12 });
		expect(text).toContain("NOT finished");
		expect(text).toContain("Being stuck is NOT a reason to stop");
		expect(text).toContain("pivot");
		expect(text).toContain("submit_science_plan");
	});
});

describe("runScienceLoop", () => {
	test("model never submits → rounds exhausted → budget_exhausted (science-mode entry/exit correct)", async () => {
		const { kernel } = await setup((faux) => {
			faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("exploring")));
		});
		const report = await runScienceLoop(kernel, {
			cwd: workdir,
			problem: "any problem",
			maxRounds: 2,
			wallClockMs: 120_000,
		});
		expect(report.outcome).toBe("budget_exhausted");
		expect(report.rounds).toBe(2);
		expect(kernel.scienceMode).toBe(false); // finally leaves science mode off after the loop
		await kernel.close();
	}, 60_000);

	test("wall-clock exhausted → budget_exhausted", async () => {
		const { kernel } = await setup((faux) => {
			faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("exploring")));
		});
		const report = await runScienceLoop(kernel, {
			cwd: workdir,
			problem: "any problem",
			maxRounds: 10,
			wallClockMs: 1,
		});
		expect(report.outcome).toBe("budget_exhausted");
		expect(report.detail).toContain("wall-clock");
		expect(kernel.scienceMode).toBe(false);
		await kernel.close();
	}, 60_000);

	test("transient disconnect → retry the round instead of killing the science loop (regression)", async () => {
		const { kernel } = await setup((faux) => {
			faux.setResponses([
				fauxAssistantMessage("partial exploration before disconnect", {
					stopReason: "error",
					errorMessage: "The socket connection was closed unexpectedly",
				}),
				...Array.from({ length: 4 }, () => fauxAssistantMessage("exploring")),
			]);
		});
		const report = await runScienceLoop(kernel, {
			cwd: workdir,
			problem: "any problem",
			maxRounds: 1,
			wallClockMs: 120_000,
			transientBackoffMs: 5,
		});
		expect(report.outcome).toBe("budget_exhausted");
		expect(report.detail ?? "").not.toContain("socket");
		expect(kernel.scienceMode).toBe(false);
		await kernel.close();
	}, 60_000);

	test("first-round transient disconnect: retry re-sends the seed prompt, problem not lost (regression)", async () => {
		const { kernel } = await setup((faux) => {
			faux.setResponses([
				fauxAssistantMessage("partial exploration before disconnect", {
					stopReason: "error",
					errorMessage: "The socket connection was closed unexpectedly",
				}),
				...Array.from({ length: 4 }, () => fauxAssistantMessage("exploring")),
			]);
		});
		const report = await runScienceLoop(kernel, {
			cwd: workdir,
			problem: "predict yeast proteome divergence",
			maxRounds: 1,
			wallClockMs: 120_000,
			transientBackoffMs: 5,
		});
		expect(report.outcome).toBe("budget_exhausted");
		const userTexts = (
			kernel.agent.state.messages as unknown as Array<{
				role: string;
				content: Array<{ type: string; text?: string }>;
			}>
		)
			.filter((m) => m.role === "user")
			.flatMap((m) => m.content ?? [])
			.map((b) => (b.type === "text" ? (b.text ?? "") : ""));
		// the retried round re-sends the seed (problem statement), never a blind continuation
		expect(userTexts.filter((t) => t.includes("You are in science mode"))).toHaveLength(2);
		expect(userTexts.filter((t) => t.includes("The investigation is NOT finished"))).toHaveLength(0);
		await kernel.close();
	}, 60_000);

	test("watchdog: non-submitting model is terminated within budget → budget_exhausted (no dangling run)", async () => {
		const { kernel } = await setup((faux) => {
			faux.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage("still exploring")));
		});
		const startedAt = Date.now();
		const report = await runScienceLoop(kernel, {
			cwd: workdir,
			problem: "any problem",
			maxRounds: 20,
			wallClockMs: 1_500,
		});
		const elapsed = Date.now() - startedAt;
		expect(report.outcome).toBe("budget_exhausted");
		expect(kernel.scienceMode).toBe(false);
		// the watchdog bounds the run to the wall clock (faux rounds are instant, so the top-of-round
		// deadline check or the in-flight abort settles it just past the cap, never far beyond)
		expect(elapsed).toBeLessThan(15_000);
		await kernel.close();
	}, 60_000);

	test("model calls submit (leaves science mode) → submitted", async () => {
		// a fake submit tool mirrors submit_science_plan's exit-science-mode effect, so the loop can observe submission.
		// It must be named submit_science_plan: the science-readonly rule lets only that tool (and science_plan) through.
		let kernelRef: Kernel | undefined;
		let submitted = false;
		const submitTool: AgentTool = {
			name: "submit_science_plan",
			label: "Submit plan",
			description: "Submit the plan and leave science mode",
			parameters: Type.Object({ plan: Type.String() }),
			executionMode: "sequential",
			async execute(_id: unknown, _params: unknown, _signal: unknown, _onUpdate: unknown) {
				submitted = true;
				kernelRef?.setScienceMode(false);
				return { content: [{ type: "text", text: "submitted" }], details: {} };
			},
		} as unknown as AgentTool;

		const { kernel } = await setup(
			(faux) => {
				faux.setResponses([
					fauxAssistantMessage("exploring hypotheses"),
					fauxAssistantMessage([fauxToolCall("submit_science_plan", { plan: "final plan" })]),
					fauxAssistantMessage("plan submitted"),
				]);
			},
			[submitTool],
		);
		kernelRef = kernel;

		const report = await runScienceLoop(kernel, {
			cwd: workdir,
			problem: "any problem",
			maxRounds: 5,
			wallClockMs: 120_000,
		});
		expect(submitted).toBe(true);
		expect(report.outcome).toBe("submitted");
		expect(report.rounds).toBe(2);
		expect(kernel.scienceMode).toBe(false);
		await kernel.close();
	}, 60_000);
});
