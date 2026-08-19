import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createKernel, type Kernel } from "@kea/core";
import { saveMobai } from "@kea/research";
import { afterAll, describe, expect, test, vi } from "vitest";
import { runMobaiLoop } from "../src/headless/mobai.ts";
import { makeTempDir, removeTempDir } from "./helpers/temp-dir.ts";

// checkMobai is module-mocked so the TOCTOU window (ledger vanishing/corrupting between load and check)
// is deterministic; everything else passes through unchanged.
vi.mock("@kea/research", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@kea/research")>();
	return { ...actual, checkMobai: vi.fn(actual.checkMobai) };
});

let workdir: string;

afterAll(async () => {
	if (workdir) await removeTempDir(workdir);
});

async function makeKernel(): Promise<Kernel> {
	workdir = await makeTempDir("kea2-mobaitoctou-");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const m = faux.getModel();
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("working on it")));
	return createKernel({ cwd: workdir, models, model: `${m.provider}/${m.id}`, permissionMode: "auto", headless: true });
}

async function seedFailingMobai(): Promise<void> {
	await saveMobai(workdir, {
		objective: "impossible",
		criteria: [{ check: "command", description: "always fails", command: "exit 1", expect_exit: 0 }],
		status: "active",
		updatedAt: Date.now(),
		frontier: [
			{ id: "a1", kind: "attack", description: "direct", falsification_criterion: "counterexample", status: "open" },
		],
		progress: [],
	});
}

describe("runMobaiLoop checkMobai TOCTOU (ledger vanishes between load and check)", () => {
	test("round-start check throws: round cap → budget_exhausted; no cap → blocked (no terminal error)", async () => {
		const kernel = await makeKernel();
		await seedFailingMobai();
		const mocked = vi.mocked(await import("@kea/research").then((m) => m.checkMobai));
		mocked.mockClear();
		mocked.mockRejectedValueOnce(new Error("no active mobai (mobai.json)"));
		const report = await runMobaiLoop(kernel, { cwd: workdir, maxRounds: 3, wallClockMs: 120_000 });
		expect(report.outcome).toBe("budget_exhausted");
		expect(report.rounds).toBe(0);
		expect(report.detail).toContain("no active mobai");
		await kernel.close();

		const kernel2 = await makeKernel();
		await seedFailingMobai();
		mocked.mockClear();
		mocked.mockRejectedValueOnce(new Error("no active mobai (mobai.json)"));
		const report2 = await runMobaiLoop(kernel2, { cwd: workdir });
		expect(report2.outcome).toBe("blocked");
		expect(report2.rounds).toBe(0);
		expect(report2.detail).toContain("no active mobai");
		await kernel2.close();
	}, 60_000);

	test("terminal recheck throws → budget_exhausted per round-cap semantics, not a whole-run error", async () => {
		const kernel = await makeKernel();
		await seedFailingMobai();
		const spy = vi.spyOn(kernel.subagents, "run").mockResolvedValue({
			id: "stub",
			profile: "default",
			summary: "",
			turns: 0,
			budgetExhausted: false,
			failed: false,
		});
		const mocked = vi.mocked(await import("@kea/research").then((m) => m.checkMobai));
		mocked.mockClear();
		const passthrough = mocked.getMockImplementation();
		if (!passthrough) throw new Error("checkMobai mock has no base implementation");
		mocked.mockImplementationOnce(passthrough); // round-1 top check: real failing results
		mocked.mockRejectedValueOnce(new Error("no active mobai (mobai.json)")); // terminal recheck
		const report = await runMobaiLoop(kernel, { cwd: workdir, maxRounds: 1, wallClockMs: 120_000 });
		expect(report.outcome).toBe("budget_exhausted");
		expect(report.rounds).toBe(1);
		expect(report.detail).toContain("no active mobai");
		spy.mockRestore();
		await kernel.close();
	}, 60_000);
});
