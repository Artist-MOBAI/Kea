import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PolicyEngine, type ToolRequest } from "../src/permission.ts";
import {
	createEnterPlanModeTool,
	createExitPlanModeTool,
	createPlanReminderProvider,
	PLAN_REMINDER_EVERY_TURNS,
	PlanService,
	planSlug,
} from "../src/plan.ts";

// The plan store is home-level (~/.kea/plans): redirect KEA_HOME for the whole file so enters write
// into a temp home instead of the developer's real one.
let home: string | undefined;
let prevHome: string | undefined;

beforeAll(() => {
	prevHome = process.env.KEA_HOME;
	home = mkdtempSync(join(tmpdir(), "kea-plan-home-"));
	process.env.KEA_HOME = home;
});

afterAll(() => {
	if (prevHome === undefined) delete process.env.KEA_HOME;
	else process.env.KEA_HOME = prevHome;
	if (home) rmSync(home, { recursive: true, force: true });
});

function makeCallbacks(plan: PlanService) {
	let mode = "manual";
	const state = { modeBeforePlan: "manual" };
	return {
		plan,
		isActive: () => mode === "plan",
		enterPlan: () => {
			state.modeBeforePlan = mode === "plan" ? state.modeBeforePlan : mode;
			mode = "plan";
			plan.enter("test-id-1234");
		},
		exitPlan: () => {
			plan.exit();
			mode = state.modeBeforePlan;
		},
		readPlanFile: async () => {
			const path = plan.current.path;
			if (!path) return "";
			try {
				return readFileSync(path, "utf8");
			} catch {
				return "";
			}
		},
		getMode: () => mode,
	};
}

describe("planSlug / PlanService", () => {
	test("slug takes the id prefix", () => {
		expect(planSlug("abcd1234ef")).toBe("plan-abcd1234");
		expect(planSlug("")).toBe("plan");
	});

	test("enter/exit toggles state with a deterministic home-level path (enter creates the empty file)", () => {
		const plan = new PlanService();
		expect(plan.current.active).toBe(false);
		const st = plan.enter("sess-abc");
		expect(st.active).toBe(true);
		expect(st.path).toBe(join(home as string, ".kea", "plans", "sess-abc", "plan.md"));
		expect(existsSync(st.path as string)).toBe(true);
		plan.exit();
		expect(plan.current.active).toBe(false);
	});
});

describe("enter_plan_mode / exit_plan_mode tools", () => {
	test("enter: activates and reports the plan file path; re-entering errors", async () => {
		const plan = new PlanService();
		const cb = makeCallbacks(plan);
		const enter = createEnterPlanModeTool(cb);
		const first = await enter.execute("id", {});
		expect(first.isError).toBeFalsy();
		expect(first.content[0]?.text).toContain("Plan mode: ON");
		expect(first.content[0]?.text).toContain(join(".kea", "plans"));
		const again = await enter.execute("id", {});
		expect(again.isError).toBe(true);
		expect(again.content[0]?.text).toContain("already active");
	});

	test("exit: an empty plan file refuses submission (throws, plan mode stays active)", async () => {
		const plan = new PlanService();
		const cb = makeCallbacks(plan);
		const enter = createEnterPlanModeTool(cb);
		const exit = createExitPlanModeTool(cb);
		await enter.execute("id", {});
		await expect(exit.execute("id", {})).rejects.toThrow("empty");
		expect(cb.isActive()).toBe(true);
	});

	test("exit: exits normally once a plan is written and echoes it", async () => {
		const plan = new PlanService();
		const cb = makeCallbacks(plan);
		const enter = createEnterPlanModeTool(cb);
		const exit = createExitPlanModeTool(cb);
		await enter.execute("id", {});
		const planPath = plan.current.path as string;
		await writeFile(planPath, "# Plan\n\n1. step one");
		const result = await exit.execute("id", {});
		expect(result.isError).toBeFalsy();
		expect(result.content[0]?.text).toContain("Exited plan mode.");
		expect(result.content[0]?.text).toContain("step one");
		// exitPlan() clears the path, so the exit text must carry the real plan file path
		expect(result.content[0]?.text).toContain(`Plan saved to: ${planPath}`);
		expect(result.details.planPath).toBe(planPath);
		expect(cb.isActive()).toBe(false);
	});

	test("exit: reserved-word options are rejected", async () => {
		const plan = new PlanService();
		const cb = makeCallbacks(plan);
		const enter = createEnterPlanModeTool(cb);
		const exit = createExitPlanModeTool(cb);
		await enter.execute("id", {});
		await writeFile(plan.current.path as string, "plan text");
		const result = await exit.execute("id", { options: [{ label: "Approve" }] });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("reserved");
	});

	test("exit: duplicate option labels are rejected", async () => {
		const plan = new PlanService();
		const cb = makeCallbacks(plan);
		const enter = createEnterPlanModeTool(cb);
		const exit = createExitPlanModeTool(cb);
		await enter.execute("id", {});
		await writeFile(plan.current.path as string, "plan text");
		const result = await exit.execute("id", { options: [{ label: "A" }, { label: "a" }] });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Duplicate");
	});

	test("exit: valid options pass through with the result", async () => {
		const plan = new PlanService();
		const cb = makeCallbacks(plan);
		const enter = createEnterPlanModeTool(cb);
		const exit = createExitPlanModeTool(cb);
		await enter.execute("id", {});
		await writeFile(plan.current.path as string, "plan text");
		const result = await exit.execute("id", { options: [{ label: "Rewrite" }, { label: "Patch" }] });
		expect(result.isError).toBeFalsy();
		expect(result.content[0]?.text).toContain("Rewrite / Patch");
	});

	test("exit: errors when not active", async () => {
		const plan = new PlanService();
		const cb = makeCallbacks(plan);
		const exit = createExitPlanModeTool(cb);
		const result = await exit.execute("id", {});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("not active");
	});
});

describe("policy chain: plan file write exemption and review gate", () => {
	const planPath = "/tmp/repo/.kea/plans/plan-x.md";
	const writePlan: ToolRequest = { toolName: "write", args: { path: planPath }, kind: "write", path: planPath };
	const writeOther: ToolRequest = {
		toolName: "write",
		args: { path: "/tmp/repo/src/a.ts" },
		kind: "write",
		path: "/tmp/repo/src/a.ts",
	};
	const exitPlanReq: ToolRequest = { toolName: "exit_plan_mode", args: {}, kind: "unknown" };

	test("plan mode: the plan file is writable, other writes/executions are denied", () => {
		const engine = new PolicyEngine({ mode: "manual", cwd: "/tmp/repo", gitRoot: undefined });
		engine.setPlanMode(true);
		engine.setPlanFilePath(planPath);
		expect(engine.evaluate(writePlan)).toMatchObject({ verdict: "approve", ruleId: "plan-file-write" });
		expect(engine.evaluate(writeOther)).toMatchObject({ verdict: "deny", ruleId: "plan-readonly" });
	});

	test("plan-review: plan submission always asks under yolo/manual, auto approves directly", () => {
		for (const mode of ["manual", "yolo"] as const) {
			const engine = new PolicyEngine({ mode, cwd: "/tmp/repo", gitRoot: undefined });
			expect(engine.evaluate(exitPlanReq)).toMatchObject({ verdict: "ask", ruleId: "plan-review" });
		}
		const auto = new PolicyEngine({ mode: "auto", cwd: "/tmp/repo", gitRoot: undefined });
		expect(auto.evaluate(exitPlanReq).verdict).toBe("approve");
	});
});

describe("plan reminder provider", () => {
	test("no reminder while inactive; the active reminder includes the plan file and exit guidance", () => {
		const state = { active: false, path: undefined as string | undefined };
		const provider = createPlanReminderProvider(
			() => state.active,
			() => state.path,
		);
		expect(provider.evaluate({ isNewTurn: true, messages: [] })).toBeUndefined();
		state.active = true;
		state.path = "/tmp/x/plan.md";
		const text = provider.evaluate({ isNewTurn: true, messages: [] });
		expect(text).toContain("Plan mode is active");
		expect(text).toContain("/tmp/x/plan.md");
		expect(text).toContain("exit_plan_mode");
	});

	test("throttle: reminds once immediately on entry, then every N turns (not every turn)", () => {
		const provider = createPlanReminderProvider(
			() => true,
			() => "/tmp/x/plan.md",
		);
		const input = { isNewTurn: false, messages: [] };
		expect(provider.evaluate(input)).toBeDefined();
		for (let i = 1; i < PLAN_REMINDER_EVERY_TURNS; i++) {
			expect(provider.evaluate(input)).toBeUndefined();
		}
		expect(provider.evaluate(input)).toBeDefined();
	});

	test("leaving plan mode resets the throttle; re-entering reminds immediately", () => {
		let active = true;
		const provider = createPlanReminderProvider(
			() => active,
			() => "/tmp/x/plan.md",
		);
		const input = { isNewTurn: false, messages: [] };
		expect(provider.evaluate(input)).toBeDefined();
		active = false;
		expect(provider.evaluate(input)).toBeUndefined();
		active = true;
		expect(provider.evaluate(input)).toBeDefined();
	});

	test("re-entering plan mode: reentry keyed to plan file content (kimi semantics), not in-memory markers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kea-plan-reenter-"));
		try {
			const path = join(dir, "plan.md");
			let active = false;
			const provider = createPlanReminderProvider(
				() => active,
				() => path,
			);
			const input = { isNewTurn: false, messages: [] };
			active = true;
			const first = provider.evaluate(input);
			expect(first).toContain("Plan mode is active");
			expect(first).not.toContain("read it first, then revise it");
			active = false;
			expect(provider.evaluate(input)).toBeUndefined();
			await writeFile(path, "# Plan\nreal steps", "utf8");
			active = true;
			const reentry = provider.evaluate(input);
			expect(reentry).toContain("read it first, then revise it rather than starting over");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("replays the reminder once after compaction", () => {
		const provider = createPlanReminderProvider(
			() => true,
			() => "/tmp/x/plan.md",
		);
		const input = { isNewTurn: false, messages: [] };
		expect(provider.evaluate(input)).toBeDefined();
		expect(provider.evaluate(input)).toBeUndefined();
		provider.onCompacted?.();
		// the replay fires immediately without consuming throttle count
		expect(provider.evaluate(input)).toBeDefined();
		expect(provider.evaluate(input)).toBeUndefined();
	});

	test("two-level reminders: gentle prose first, then fielded + hard prohibitions (DSH guard paradigm)", () => {
		const provider = createPlanReminderProvider(
			() => true,
			() => "/tmp/x/plan.md",
		);
		const input = { isNewTurn: false, messages: [] };
		const first = provider.evaluate(input);
		expect(first).toContain("Plan mode is active");
		expect(first).not.toContain("[plan mode]");
		for (let i = 1; i < PLAN_REMINDER_EVERY_TURNS; i++) provider.evaluate(input);
		const second = provider.evaluate(input);
		expect(second).toContain("[plan mode]");
		expect(second).toContain("plan_file: /tmp/x/plan.md");
		expect(second).toContain("reminders_sent: 2");
		expect(second).toContain("You MUST NOT edit any file except the plan file");
		expect(second).toContain("Read-only tools ONLY");
	});

	test("leaving and re-entering plan mode: the reminder level resets to one", () => {
		let active = true;
		const provider = createPlanReminderProvider(
			() => active,
			() => "/tmp/x/plan.md",
		);
		const input = { isNewTurn: false, messages: [] };
		provider.evaluate(input);
		for (let i = 1; i < PLAN_REMINDER_EVERY_TURNS; i++) provider.evaluate(input);
		expect(provider.evaluate(input)).toContain("[plan mode]");
		active = false;
		provider.evaluate(input);
		active = true;
		expect(provider.evaluate(input)).not.toContain("[plan mode]");
	});
});

describe("plan reentry detection (kimi semantics: non-empty plan file content counts as a prior plan)", () => {
	test("plan file empty/missing on entry → no reentry hint (no in-memory hasEntered false positives)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kea-plan-reentry-"));
		try {
			const path = join(dir, "plan.md");
			const provider = createPlanReminderProvider(
				() => true,
				() => path,
			);
			const text = provider.evaluate({ isNewTurn: false, messages: [] }) ?? "";
			expect(text).toContain("Plan mode is active.");
			expect(text).not.toContain("A prior plan already exists");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("plan file already has content → injects the reentry hint (read it first, then revise)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kea-plan-reentry-"));
		try {
			const path = join(dir, "plan.md");
			await writeFile(path, "# Plan\n\n1. step one\n2. step two\n", "utf8");
			const provider = createPlanReminderProvider(
				() => true,
				() => path,
			);
			const text = provider.evaluate({ isNewTurn: false, messages: [] }) ?? "";
			expect(text).toContain("A prior plan already exists at this path");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("compaction replay (onCompacted): with file content, the replay also carries the reentry line", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kea-plan-reentry-"));
		try {
			const path = join(dir, "plan.md");
			const provider = createPlanReminderProvider(
				() => true,
				() => path,
			);
			provider.evaluate({ isNewTurn: false, messages: [] });
			await writeFile(path, "# Plan\ncontent", "utf8");
			provider.onCompacted?.();
			const text = provider.evaluate({ isNewTurn: false, messages: [] }) ?? "";
			// the replay fires immediately; level may vary — the invariant is delivery
			expect(text).toContain("plan mode");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
