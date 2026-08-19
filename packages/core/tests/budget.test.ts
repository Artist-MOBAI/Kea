import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, test } from "vitest";
import { aggregateUsage, BudgetGuard } from "../src/budget.ts";
import { createKernel } from "../src/kernel.ts";
import { wrapSystemReminder } from "../src/text.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

describe("budget guard (M1)", () => {
	test("unit: each dimension triggers with a message", () => {
		const guard = new BudgetGuard({ iterations: 2, tokens: 1000, usd: 0.5, wallClockMs: 60_000, concurrentJobs: 1 });
		const base = { turns: 1, tokens: 500, usd: 0.1, promptStartedAt: Date.now() };
		expect(guard.checkTurn(base)).toBeUndefined();
		expect(guard.checkTurn({ ...base, turns: 2 })?.exceeded).toBe("iterations");
		expect(guard.checkTurn({ ...base, tokens: 1200 })?.exceeded).toBe("tokens");
		expect(guard.checkTurn({ ...base, usd: 0.6 })?.exceeded).toBe("usd");
		expect(guard.checkTurn({ ...base, promptStartedAt: Date.now() - 70_000 })?.exceeded).toBe("wallClockMs");
		expect(guard.checkJobs(0)).toBeUndefined();
		expect(guard.checkJobs(1)?.exceeded).toBe("concurrentJobs");
	});

	test("aggregateUsage sums assistant usage only", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "yo" }],
				timestamp: 2,
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } },
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "again" }],
				timestamp: 3,
				usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: { total: 0.02 } },
			},
		];
		const usage = aggregateUsage(messages as never);
		expect(usage.tokens).toBe(40);
		expect(usage.usd).toBeCloseTo(0.03);
	});

	test("kernel: iteration budget allows one wrap-up turn, then hard-stops", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-budget-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const m = faux.getModel();
		faux.setResponses([
			fauxAssistantMessage("working on it"),
			fauxAssistantMessage("WRAP-UP: best result persisted, stopping now."),
			fauxAssistantMessage("never reached"),
		]);

		const kernel = await createKernel({
			cwd: workdir,
			models,
			model: `${m.provider}/${m.id}`,
			budget: { iterations: 1 },
		});
		await kernel.prompt("Do a long task.");
		await kernel.agent.waitForIdle();

		expect(faux.state.callCount).toBe(2);
		expect(faux.getPendingResponseCount()).toBe(1);
		const text = JSON.stringify(kernel.agent.state.messages);
		expect(text).toContain("[budget]");
		expect(text).toContain("WRAP-UP: best result persisted");
		expect(text).not.toContain("never reached");
		const state = kernel.budgetState();
		expect(state?.exceeded).toBe("iterations");
	}, 30_000);

	test("wrap-up reminder uses the fielded + hard-prohibition form (single injection point is the escalated form)", () => {
		const text = BudgetGuard.wrapUpMessage({ exceeded: "iterations", message: "turn budget exhausted (2/2)" });
		expect(text).toContain("[budget]");
		expect(text).toContain("State: dimension=iterations.");
		expect(text).toContain("FINAL turn");
		expect(text).toContain("do NOT start new work");
		expect(text).toContain("Wrap up instead");
	});

	test("wrapper goes through text.ts single-source wrapSystemReminder (byte-equality anchor)", () => {
		const text = BudgetGuard.wrapUpMessage({ exceeded: "tokens", message: "token budget exhausted (1/1)" });
		expect(text.startsWith("<system-reminder>\n")).toBe(true);
		expect(text.endsWith("\n</system-reminder>")).toBe(true);
		const body = text.slice("<system-reminder>\n".length, -("</system-reminder>".length + 1));
		expect(text).toBe(wrapSystemReminder(body));
	});
});
