import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
	classifyTool,
	findGitRoot,
	normalizePath,
	PolicyEngine,
	requestIdentity,
	SessionApprovals,
	type ToolRequest,
} from "../src/permission.ts";

const cwd = "/tmp/kea-policy-tests";
const bash = (command: string): ToolRequest => ({ toolName: "bash", args: { command }, kind: "exec", command });
const read = (path = "src/x.ts"): ToolRequest => ({ toolName: "read", args: { path }, kind: "read", path });
const write = (path = "src/x.ts"): ToolRequest => ({ toolName: "write", args: { path }, kind: "write", path });

// at: run the engine at this cwd, leaving gitRoot empty so findGitRoot probes for real (more end-to-end)
const engine = (mode: "manual" | "auto" | "yolo", gitRoot?: string, at?: string): PolicyEngine =>
	new PolicyEngine({ mode, cwd: at ?? cwd, gitRoot: gitRoot ?? undefined });

const tempDirs: string[] = [];

afterAll(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

// fake worktree root with a .git subdir (findGitRoot only probes existsSync(join(dir, ".git")))
async function makeFakeWorktree(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kea2-policy-wt-"));
	await mkdir(join(root, ".git"), { recursive: true });
	tempDirs.push(root);
	return root;
}

describe("policy chain: mode semantics", () => {
	test("manual: reads approved, writes/exec fall through to ask", () => {
		const e = engine("manual");
		expect(e.evaluate(read())).toMatchObject({ verdict: "approve", ruleId: "reads-free" });
		expect(e.evaluate(write())).toMatchObject({ verdict: "ask", ruleId: "fallback-ask" });
		expect(e.evaluate(bash("ls"))).toMatchObject({ verdict: "ask", ruleId: "fallback-ask" });
	});

	test("plan: read-only enforced at the policy layer (reads approved, writes/exec denied)", () => {
		const e = engine("manual");
		e.setPlanMode(true);
		expect(e.evaluate(read()).verdict).toBe("approve");
		expect(e.evaluate(write())).toMatchObject({ verdict: "deny", ruleId: "plan-readonly" });
		expect(e.evaluate(bash("echo hi"))).toMatchObject({ verdict: "deny", ruleId: "plan-readonly" });
	});

	test("plan: exit passes to review gate; read-only/status tools approved; sensitive reads still ask", async () => {
		const e = engine("manual");
		e.setPlanMode(true);
		e.setPlanFilePath("/tmp/kea-policy-tests/.kea/plans/plan-a.md");
		// plan mode must be exitable: exit goes to plan-review (ask), not denied by plan-readonly
		expect(e.evaluate({ toolName: "exit_plan_mode", args: {}, kind: "unknown" })).toMatchObject({
			verdict: "ask",
			ruleId: "plan-review",
		});
		for (const name of ["todo_list", "fetch_url", "web_search", "read_media_file", "enter_plan_mode"]) {
			expect(e.evaluate({ toolName: name, args: {}, kind: "unknown" }).verdict, name).toBe("approve");
		}
		expect(e.evaluate(read(".env"))).toMatchObject({ verdict: "ask", ruleId: "plan-sensitive-ask" });
		expect(e.evaluate(read(".git/config"))).toMatchObject({ verdict: "ask", ruleId: "plan-sensitive-ask" });
		expect(e.evaluate(write(".kea/plans/plan-a.md"))).toMatchObject({ verdict: "approve", ruleId: "plan-file-write" });
	});

	test("auto: everything approved (including sensitive files — deliberately asymmetric with yolo)", async () => {
		const e = engine("auto");
		expect(e.evaluate(write("src/.env")).verdict).toBe("approve");
		expect(e.evaluate(bash("echo hi")).verdict).toBe("approve");
	});

	test("yolo: ordinary writes/exec approved, but sensitive files and .git internals still ask", async () => {
		const e = engine("yolo");
		expect(e.evaluate(write("src/x.ts"))).toMatchObject({ verdict: "approve", ruleId: "mode-yolo" });
		expect(e.evaluate(bash("echo hi"))).toMatchObject({ verdict: "approve", ruleId: "mode-yolo" });
		expect(e.evaluate(write(".env"))).toMatchObject({ verdict: "ask", ruleId: "sensitive-file-ask" });
		expect(e.evaluate(read("~/.ssh/id_rsa"))).toMatchObject({ verdict: "ask", ruleId: "sensitive-file-ask" });
		expect(e.evaluate(write(".git/config"))).toMatchObject({ verdict: "ask", ruleId: "git-internal-ask" });
	});

	test("setMode switches verdicts live (plan orthogonal: plan still denies under auto)", () => {
		const e = engine("manual");
		expect(e.evaluate(write()).verdict).toBe("ask");
		e.setPlanMode(true);
		expect(e.evaluate(write()).verdict).toBe("deny");
		e.setMode("auto");
		expect(e.evaluate(write()).verdict).toBe("deny");
		e.setPlanMode(false);
		expect(e.evaluate(write()).verdict).toBe("approve");
		expect(e.currentMode).toBe("auto");
	});
});

describe("policy chain: session approvals (by request identity)", () => {
	test("bash remembered by command literal: same command approved, different commands still ask", async () => {
		const e = engine("manual");
		const req = bash("bun run test");
		expect(e.evaluate(req).verdict).toBe("ask");
		e.approvals.remember(req);
		expect(e.evaluate(bash("bun run test"))).toMatchObject({ verdict: "approve", ruleId: "session-approval" });
		expect(e.evaluate(bash("bun run check")).verdict).toBe("ask");
	});

	test("file tools remembered by normalized path: ./x and x share one identity", async () => {
		const e = engine("manual");
		e.approvals.remember(write("./src/x.ts"));
		expect(e.evaluate(write("src/x.ts")).verdict).toBe("approve");
		expect(e.evaluate(write("src/y.ts")).verdict).toBe("ask");
	});

	test("clear wipes all (session-switch semantics)", () => {
		const e = engine("manual");
		e.approvals.remember(bash("ls"));
		e.approvals.clear();
		expect(e.evaluate(bash("ls")).verdict).toBe("ask");
	});

	test("verb isolation: approving a read never implies approving a write (no sensitive escalation)", async () => {
		const e = engine("yolo");
		e.approvals.remember(read(".env"));
		expect(e.evaluate(read(".env"))).toMatchObject({ verdict: "approve", ruleId: "session-approval" });
		expect(e.evaluate(write(".env"))).toMatchObject({ verdict: "ask", ruleId: "sensitive-file-ask" });
	});

	test("session approvals outrank mode fallback, but plan deny cannot be bypassed", async () => {
		const e = engine("manual");
		e.setPlanMode(true);
		e.approvals.remember(write("src/x.ts"));
		expect(e.evaluate(write("src/x.ts")).verdict).toBe("deny");
	});
});

describe("git worktree write auto-approval", () => {
	test("under manual, writes inside the git worktree are approved, outside still ask", async () => {
		const e = engine("manual", "/tmp/repo");
		expect(e.evaluate(write("/tmp/repo/src/a.ts"))).toMatchObject({ verdict: "approve", ruleId: "git-worktree-write" });
		expect(e.evaluate(write("/tmp/other/a.ts")).verdict).toBe("ask");
	});

	test("non-git directory (gitRoot undefined) does not trigger", () => {
		const e = engine("manual");
		expect(e.evaluate(write("src/a.ts"))).toMatchObject({ verdict: "ask", ruleId: "fallback-ask" });
	});

	test("absolute path escaping the worktree via .. → ask (not auto-approved)", async () => {
		const e = engine("manual", "/tmp/repo");
		expect(e.evaluate(write("/tmp/repo/../evil.sh")).verdict).toBe("ask");
		expect(e.evaluate(write("/tmp/repo/src/../../evil.sh")).verdict).toBe("ask");
	});

	test("relative path escaping the worktree via .. → ask", async () => {
		const e = engine("manual", "/tmp/repo");
		expect(e.evaluate(write("../evil.sh")).verdict).toBe("ask");
	});

	test("sibling-prefix directories (/repo vs /repo-evil) are not containment → ask", async () => {
		const e = engine("manual", "/tmp/repo");
		expect(e.evaluate(write("/tmp/repo-evil/a.ts")).verdict).toBe("ask");
	});

	test("absolute paths inside the worktree still auto-approved (non-escaping .. folds included)", async () => {
		const e = engine("manual", "/tmp/repo");
		expect(e.evaluate(write("/tmp/repo/src/a.ts"))).toMatchObject({ verdict: "approve", ruleId: "git-worktree-write" });
		expect(e.evaluate(write("/tmp/repo/src/../src/a.ts"))).toMatchObject({
			verdict: "approve",
			ruleId: "git-worktree-write",
		});
	});

	// Chain-order safety contract: sensitive-file-ask must come before git-worktree-write.
	// If the two were reversed, writes to .env/id_rsa inside the worktree would be silently auto-approved by git-worktree-write.
	test("sensitive writes inside the worktree still ask (manual/yolo × .env/id_rsa, chain order pinned)", async () => {
		for (const mode of ["manual", "yolo"] as const) {
			const worktree = await makeFakeWorktree();
			// gitRoot deliberately not passed: the engine must discover the fake worktree via findGitRoot
			const e = engine(mode, undefined, worktree);
			for (const sensitive of [".env", "id_rsa"]) {
				const decision = e.evaluate(write(join(worktree, sensitive)));
				expect(decision, `${mode} × ${sensitive}`).toMatchObject({
					verdict: "ask",
					ruleId: "sensitive-file-ask",
				});
			}
			// control: the same worktree approves a non-sensitive write, proving git-worktree-write is armed
			// and the ask above can only come from sensitive-file-ask firing first
			const normal = e.evaluate(write(join(worktree, "src", "a.ts")));
			expect(normal.verdict, `${mode} × non-sensitive control`).toBe("approve");
			if (mode === "manual") expect(normal.ruleId).toBe("git-worktree-write");
		}
	});
});

describe("request identity and path normalization", () => {
	test("requestIdentity three forms (file identity includes the verb)", () => {
		expect(requestIdentity(bash("ls -la"))).toBe("bash:ls -la");
		expect(requestIdentity(write("src/x.ts"))).toBe("write:src/x.ts");
		expect(requestIdentity(read("src/x.ts"))).toBe("read:src/x.ts");
		expect(requestIdentity({ toolName: "run_experiment", args: {}, kind: "unknown" })).toBe("tool:run_experiment");
	});

	test("absolute vs same-named relative paths do not collide (audit P1#2: no cross-root approval reuse)", async () => {
		expect(normalizePath("/etc/passwd")).toBe("/etc/passwd");
		expect(normalizePath("etc/passwd")).toBe("etc/passwd");
		expect(requestIdentity(write("/etc/passwd"))).not.toBe(requestIdentity(write("etc/passwd")));
		expect(requestIdentity(write("etc/passwd"))).toBe("write:etc/passwd");
		expect(requestIdentity(write("/etc/passwd"))).toBe("write:/etc/passwd");
	});

	test("normalizePath: folds ./ and .., case-insensitive", () => {
		expect(normalizePath("./src/x.ts")).toBe("src/x.ts");
		expect(normalizePath("src/../src/x.ts")).toBe("src/x.ts");
		expect(normalizePath("SRC/X.ts")).toBe("src/x.ts");
		expect(normalizePath("~/a")).toBe("~/a");
	});

	test("SessionApprovals independent-instance semantics", () => {
		const approvals = new SessionApprovals();
		expect(approvals.size).toBe(0);
		approvals.remember(bash("pwd"));
		expect(approvals.matches(bash("pwd"))).toBe(true);
		expect(approvals.matches(bash("whoami"))).toBe(false);
	});

	test("findGitRoot: temp dir without .git returns undefined", async () => {
		expect(findGitRoot("/tmp")).toBeUndefined();
	});

	test("findGitRoot: dir with .git returns that root; nested subdirs walk up to the same root", async () => {
		const root = await makeFakeWorktree();
		expect(findGitRoot(root)).toBe(root);
		const nested = join(root, "src", "deep");
		await mkdir(nested, { recursive: true });
		expect(findGitRoot(nested)).toBe(root);
	});
});

describe("tool classification", () => {
	test("built-in tool mapping is stable, unknown tools stay unknown", () => {
		expect(classifyTool("bash")).toBe("exec");
		expect(classifyTool("read")).toBe("read");
		expect(classifyTool("grep")).toBe("read");
		expect(classifyTool("glob")).toBe("read");
		expect(classifyTool("write")).toBe("write");
		expect(classifyTool("edit")).toBe("write");
		expect(classifyTool("mcp__mp__search")).toBe("unknown");
	});
});

describe("science mode: read-only orchestration + mutual exclusion with plan", () => {
	test("science: reads approved, writes/exec denied (read-only enforced)", async () => {
		const e = engine("manual");
		e.setScienceMode(true);
		expect(e.evaluate(read()).verdict).toBe("approve");
		expect(e.evaluate(write())).toMatchObject({ verdict: "deny", ruleId: "science-readonly" });
		expect(e.evaluate(bash("echo hi"))).toMatchObject({ verdict: "deny", ruleId: "science-readonly" });
	});

	test("science_plan / submit_science_plan not blocked by science-readonly", async () => {
		const e = engine("manual");
		e.setScienceMode(true);
		for (const name of ["science_plan", "submit_science_plan"]) {
			expect(e.evaluate({ toolName: name, args: {}, kind: "unknown" }).ruleId, name).not.toBe("science-readonly");
		}
	});

	test("science: measurement/ledger/orchestration tools approved (Kea's ledger, not the workspace)", async () => {
		const e = engine("manual");
		e.setScienceMode(true);
		for (const name of [
			"autoresearch_init",
			"autoresearch_step",
			"evaluate_solution",
			"define_evaluator",
			"check_goal",
			"verify_claim",
			"check_novelty",
			"journal_note",
			"remember",
			"start_goal",
			"update_goal",
			"spawn_agent",
			"spawn_swarm",
		]) {
			expect(e.evaluate({ toolName: name, args: {}, kind: "unknown" }), name).toMatchObject({
				verdict: "approve",
				ruleId: "science-readonly",
			});
		}
	});

	test("science and plan are mutually exclusive: entering one clears the other", async () => {
		const e = engine("manual");
		e.setScienceMode(true);
		expect(e.currentScienceMode).toBe(true);
		e.setPlanMode(true);
		expect(e.currentScienceMode).toBe(false);
		expect(e.currentPlanMode).toBe(true);
		e.setScienceMode(true);
		expect(e.currentPlanMode).toBe(false);
		expect(e.currentScienceMode).toBe(true);
	});
});

describe("user-configurable permission rules (C3: kea.toml [permission] injected at chain head)", () => {
	async function rulesDir(toml: string): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "kea2-policy-rules-"));
		await Bun.write(join(root, "kea.toml"), toml);
		tempDirs.push(root);
		return root;
	}

	test('deny = ["Bash(rm -rf *)"] still denies under yolo (outranks yolo approve)', async () => {
		const at = await rulesDir('[permission]\ndeny = ["Bash(rm -rf *)"]\n');
		const e = new PolicyEngine({ mode: "yolo", cwd: at });
		expect(e.evaluate(bash("cd /tmp && rm -rf *"))).toMatchObject({ verdict: "deny", ruleId: "user-deny" });
		expect(e.evaluate(bash("echo hi"))).toMatchObject({ verdict: "approve", ruleId: "mode-yolo" });
	});

	test('allow = ["Read"] approves directly under manual (no reads-free fallback)', async () => {
		const at = await rulesDir('[permission]\nallow = ["Read"]\n');
		const e = new PolicyEngine({ mode: "manual", cwd: at });
		expect(e.evaluate(read("src/x.ts"))).toMatchObject({ verdict: "approve", ruleId: "user-allow" });
		expect(e.evaluate(write("src/x.ts"))).toMatchObject({ verdict: "ask", ruleId: "fallback-ask" });
	});

	test('ask = ["Bash"] forces ask under auto (outranks auto approve)', async () => {
		const at = await rulesDir('[permission]\nask = ["Bash"]\n');
		const e = new PolicyEngine({ mode: "auto", cwd: at });
		expect(e.evaluate(bash("echo hi"))).toMatchObject({ verdict: "ask", ruleId: "user-ask" });
		expect(e.evaluate(write("src/x.ts"))).toMatchObject({ verdict: "approve", ruleId: "mode-auto" });
	});

	test("deny outranks allow (same request hits both sets)", async () => {
		const at = await rulesDir('[permission]\nallow = ["Bash"]\ndeny = ["Bash(curl)"]\n');
		const e = new PolicyEngine({ mode: "yolo", cwd: at });
		expect(e.evaluate(bash("curl https://evil.example"))).toMatchObject({ verdict: "deny", ruleId: "user-deny" });
		expect(e.evaluate(bash("ls"))).toMatchObject({ verdict: "approve", ruleId: "user-allow" });
	});

	test("user allow must not bypass sensitive-file ask (sensitive check precedes user-allow)", async () => {
		const at = await rulesDir('[permission]\nallow = ["Read", "Write"]\n');
		const e = new PolicyEngine({ mode: "yolo", cwd: at });
		expect(e.evaluate(read(".env"))).toMatchObject({ verdict: "ask", ruleId: "sensitive-file-ask" });
		expect(e.evaluate(write(".git/config"))).toMatchObject({ verdict: "ask", ruleId: "git-internal-ask" });
	});

	test("user ask must not soften plan read-only deny (hard rules precede user-ask)", async () => {
		const at = await rulesDir('[permission]\nask = ["Write"]\n');
		const e = new PolicyEngine({ mode: "manual", cwd: at });
		e.setPlanMode(true);
		expect(e.evaluate(write("src/x.ts"))).toMatchObject({ verdict: "deny", ruleId: "plan-readonly" });
	});

	test("user deny at the chain head: holds under plan mode too", async () => {
		const at = await rulesDir('[permission]\ndeny = ["fetch_url"]\n');
		const e = new PolicyEngine({ mode: "manual", cwd: at });
		e.setPlanMode(true);
		expect(e.evaluate({ toolName: "fetch_url", args: { url: "https://x" }, kind: "unknown" })).toMatchObject({
			verdict: "deny",
			ruleId: "user-deny",
		});
	});

	test("broken TOML fails open: warn + empty rules, engine still decides", async () => {
		const at = await rulesDir("[permission\ndeny = oops");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const e = new PolicyEngine({ mode: "yolo", cwd: at });
			expect(e.evaluate(bash("rm -rf *"))).toMatchObject({ verdict: "approve", ruleId: "mode-yolo" });
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("reloadUserRules re-reads disk; trusted:false skips project rules", async () => {
		const at = await rulesDir('[permission]\ndeny = ["Bash"]\n');
		const gated = new PolicyEngine({ mode: "yolo", cwd: at, trusted: false });
		expect(gated.evaluate(bash("ls")).verdict).toBe("approve"); // untrusted: project rules not loaded
		const e = new PolicyEngine({ mode: "yolo", cwd: at });
		expect(e.evaluate(bash("ls")).verdict).toBe("deny");
		await Bun.write(join(at, "kea.toml"), "[permission]\n");
		e.reloadUserRules();
		expect(e.evaluate(bash("ls")).verdict).toBe("approve");
	});
});
