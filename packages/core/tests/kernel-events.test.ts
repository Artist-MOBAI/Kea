import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, test } from "vitest";
import type { KernelEvent } from "../src/events.ts";
import { createKernel, resultDetailsOf, resultPreviewOf, resultTextOf } from "../src/kernel.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

async function makeWorkdir(): Promise<string> {
	workdir = await mkdtemp(join(tmpdir(), "kea2-events-"));
	return workdir;
}

function setupFaux() {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const fauxModel = faux.getModel();
	return { faux, models, spec: `${fauxModel.provider}/${fauxModel.id}` };
}

describe("kernel event payload (TUI data pipeline)", () => {
	test("tool_end carries durationMs and resultPreview (bash output visible)", async () => {
		const cwd = await makeWorkdir();
		const { faux, models, spec } = setupFaux();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo event-preview-ok" })]),
			fauxAssistantMessage("done"),
		]);

		const kernel = await createKernel({ cwd, models, model: spec, permissionMode: "auto" });
		const seen: KernelEvent[] = [];
		kernel.events.subscribe((event) => seen.push(event));

		await kernel.prompt("run echo");
		await kernel.agent.waitForIdle();

		const end = seen.find((e) => e.type === "tool_end");
		expect(end).toBeDefined();
		if (end?.type !== "tool_end") return;
		expect(end.isError).toBe(false);
		expect(end.durationMs).toBeGreaterThanOrEqual(0);
		expect(end.resultPreview).toContain("event-preview-ok");
	}, 15_000);

	test("message_delta carries incremental text", async () => {
		const cwd = await makeWorkdir();
		const { faux, models, spec } = setupFaux();
		faux.setResponses([fauxAssistantMessage("delta-visible")]);

		const kernel = await createKernel({ cwd, models, model: spec });
		const seen: KernelEvent[] = [];
		kernel.events.subscribe((event) => seen.push(event));

		await kernel.prompt("say it");
		await kernel.agent.waitForIdle();

		const deltas = seen.filter((e): e is Extract<KernelEvent, { type: "message_delta" }> => e.type === "message_delta");
		expect(deltas.length).toBeGreaterThan(0);
		const last = deltas[deltas.length - 1];
		expect(last?.text).toContain("delta-visible");
	}, 15_000);
});

describe("afterToolCall isError passthrough (MCP protocol error flag not swallowed)", () => {
	test("tool does not throw but result has isError: tool_end and transcript toolResult are both errors", async () => {
		const cwd = await makeWorkdir();
		const { faux, models, spec } = setupFaux();
		faux.setResponses([fauxAssistantMessage([fauxToolCall("flaky", {})]), fauxAssistantMessage("done")]);
		const kernel = await createKernel({
			cwd,
			models,
			model: spec,
			permissionMode: "auto",
			extraTools: [
				{
					name: "flaky",
					label: "Flaky",
					description: "returns a protocol-level error without throwing",
					parameters: Type.Object({}),
					// MCP passthrough semantics: protocol isError lives on the result object, not a thrown error; pi 0.84.1 drops it by default
					execute: async () => ({
						content: [{ type: "text", text: "protocol error payload" }],
						details: undefined,
						isError: true,
					}),
				} as unknown as AgentTool,
			],
		});
		const seen: KernelEvent[] = [];
		kernel.events.subscribe((e) => seen.push(e));

		await kernel.prompt("call flaky");
		await kernel.agent.waitForIdle();

		const end = seen.find((e) => e.type === "tool_end");
		expect(end?.type === "tool_end" && end.isError).toBe(true);
		// createToolResultMessage uses the finalized flag: the toolResult in the transcript must also be an error
		const toolResultMsg = kernel.agent.state.messages.find((m) => "role" in m && m.role === "toolResult");
		expect((toolResultMsg as { isError?: boolean } | undefined)?.isError).toBe(true);
		await kernel.close();
	}, 20_000);
});

describe("result preview helpers", () => {
	test("resultTextOf concatenates text blocks, ignores other types", () => {
		const result = {
			content: [
				{ type: "text", text: "line1" },
				{ type: "image", data: "x" },
				{ type: "text", text: "line2" },
			],
		};
		expect(resultTextOf(result)).toBe("line1\nline2");
		expect(resultTextOf(null)).toBe("");
		expect(resultTextOf({ content: "oops" })).toBe("");
	});

	test("resultPreviewOf truncates at 2KB and appends an ellipsis", () => {
		const long = "x".repeat(5000);
		const preview = resultPreviewOf({ content: [{ type: "text", text: long }] });
		expect(preview.length).toBe(2049);
		expect(preview.endsWith("…")).toBe(true);
	});

	test("resultDetailsOf passes structured details through", () => {
		const details = { jobId: "abc", backend: "local" };
		expect(resultDetailsOf({ content: [], details })).toEqual(details);
		expect(resultDetailsOf({ content: [] })).toBeUndefined();
		expect(resultDetailsOf(null)).toBeUndefined();
	});
});

describe("plan mode state wiring (/plan command and enter tool share one path)", () => {
	test("setPlanMode enters the plan store keyed by session id; off→on cycles keep one path (reentry)", async () => {
		const cwd = await makeWorkdir();
		const home = await mkdtemp(join(tmpdir(), "kea2-plan-home-"));
		process.env.KEA_HOME = home;
		try {
			const { models, spec } = setupFaux();
			const kernel = await createKernel({ cwd, models, model: spec });
			kernel.setPlanMode(true);
			const p1 = kernel.plan.path;
			expect(p1).toContain(join(".kea", "plans", kernel.sessionId, "plan.md"));
			kernel.setPlanMode(false);
			expect(kernel.plan.active).toBe(false);
			kernel.setPlanMode(true);
			// same session → same deterministic path: the old bug entered with a fresh uuid per toggle
			expect(kernel.plan.path).toBe(p1);
			expect(kernel.planMode).toBe(true);
		} finally {
			delete process.env.KEA_HOME;
			await rm(home, { recursive: true, force: true });
		}
	});
});
