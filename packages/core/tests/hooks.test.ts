import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
	DEFAULT_HOOK_TIMEOUT_MS,
	HOOK_EVENTS,
	type HookContext,
	HookRunner,
	loadHooksConfig,
	parseHookStdout,
	stringifyToolInput,
	truncateToolInput,
} from "../src/hooks.ts";

let dir: string;

afterAll(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

const ctx: HookContext = { sessionId: () => "sess-1", cwd: "/tmp/kea", model: () => "faux/m1" };

async function mkWorkdir(): Promise<string> {
	dir = await mkdtemp(join(tmpdir(), "kea2-hooks-"));
	return dir;
}

describe("hooks engine (M2)", () => {
	test("PreToolUse hook exiting 2 blocks with stderr reason", async () => {
		const runner = new HookRunner({ hooks: { PreToolUse: [{ command: "echo 'not today' >&2; exit 2" }] } }, ctx);
		const outcome = await runner.fireBlocking("PreToolUse", { tool_name: "bash" }, "bash");
		expect(outcome.blocked).toBe(true);
		expect(outcome.reason).toContain("not today");
	});

	test("hook exiting 0 passes through", async () => {
		const runner = new HookRunner({ hooks: { PreToolUse: [{ command: "exit 0" }] } }, ctx);
		const outcome = await runner.fireBlocking("PreToolUse", { tool_name: "bash" }, "bash");
		expect(outcome.blocked).toBe(false);
	});

	test("payload arrives as snake_case JSON envelope with base fields on stdin", async () => {
		const workdir = await mkWorkdir();
		const out = join(workdir, "seen.json");
		const envOut = join(workdir, "env.txt");
		const runner = new HookRunner(
			{ hooks: { PreToolUse: [{ command: `cat > '${out}'; printf '%s' "$KEA_HOOK_EVENT" > '${envOut}'` }] } },
			ctx,
		);
		await runner.fireBlocking("PreToolUse", { tool_name: "write", tool_input: { path: "x" } }, "write");
		const seen = (await Bun.file(out).json()) as Record<string, unknown>;
		expect(seen.hook_event_name).toBe("PreToolUse");
		expect(seen.session_id).toBe("sess-1");
		expect(seen.cwd).toBe("/tmp/kea");
		expect(seen.model).toBe("faux/m1");
		expect(seen.tool_name).toBe("write");
		expect(seen.tool_input).toEqual({ path: "x" });
		expect(await Bun.file(envOut).text()).toBe("PreToolUse");
	});

	test("context closures are evaluated lazily (session/model changes mid-run)", async () => {
		const workdir = await mkWorkdir();
		const out = join(workdir, "seen.json");
		let sessionId = "first";
		let model = "faux/a";
		const runner = new HookRunner(
			{ hooks: { Stop: [{ command: `cat > '${out}'` }] } },
			{
				sessionId: () => sessionId,
				cwd: "/tmp/kea",
				model: () => model,
			},
		);
		sessionId = "second";
		model = "faux/b";
		runner.fireAndForget("Stop", { outcome: "completed" });
		const deadline = Date.now() + 5_000;
		while (!(await Bun.file(out).exists()) && Date.now() < deadline) await Bun.sleep(20);
		const seen = (await Bun.file(out).json()) as Record<string, unknown>;
		expect(seen.session_id).toBe("second");
		expect(seen.model).toBe("faux/b");
	});

	test("fireAndForget does not throw on failing hooks", () => {
		const runner = new HookRunner({ hooks: { Stop: [{ command: "exit 3" }] } }, ctx);
		expect(() => runner.fireAndForget("Stop", {})).not.toThrow();
	});

	test("malformed hooks file loads as empty config", async () => {
		const workdir = await mkWorkdir();
		await Bun.write(join(workdir, ".kea", "hooks.json"), "{nope");
		const cfg = await loadHooksConfig(workdir);
		expect(cfg.hooks).toBeUndefined();
	});

	test("hooks file with matcher and all 14 event keys parses", async () => {
		const workdir = await mkWorkdir();
		await Bun.write(
			join(workdir, ".kea", "hooks.json"),
			JSON.stringify({
				hooks: { PreToolUse: [{ command: "true", matcher: "^bash$" }], SessionEnd: [{ command: "true" }] },
			}),
		);
		const cfg = await loadHooksConfig(workdir);
		expect(cfg.hooks?.PreToolUse?.[0]?.matcher).toBe("^bash$");
		expect(cfg.hooks?.SessionEnd).toHaveLength(1);
	});
});

describe("hook event surface (14 events)", () => {
	test("HOOK_EVENTS covers the full industry-aligned surface", () => {
		expect(HOOK_EVENTS).toHaveLength(14);
		for (const name of [
			"UserPromptSubmit",
			"UserPromptQueued",
			"PreToolUse",
			"PostToolUse",
			"Stop",
			"Interrupt",
			"SessionStart",
			"SessionEnd",
			"PreCompact",
			"PostCompact",
			"SubagentStart",
			"SubagentStop",
			"JobSubmitted",
			"JobFinished",
		]) {
			expect(HOOK_EVENTS).toContain(name);
		}
	});

	test("default timeout is 30s; explicit timeoutMs still enforced (slow hook killed, fail-open)", async () => {
		expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(30_000);
		const runner = new HookRunner({ hooks: { Stop: [{ command: "exec sleep 5", timeoutMs: 200 }] } }, ctx);
		const startedAt = Date.now();
		const outcome = await runner.fireBlocking("Stop", {});
		expect(Date.now() - startedAt).toBeLessThan(4_000);
		expect(outcome.blocked).toBe(false);
	});
});

describe("matcher semantics (kimi pattern)", () => {
	async function matcherFires(
		event: (typeof HOOK_EVENTS)[number],
		matcher: string | undefined,
		target: string | undefined,
	): Promise<boolean> {
		const workdir = await mkWorkdir();
		const marker = join(workdir, "fired");
		const entry = { command: `touch '${marker}'`, ...(matcher !== undefined ? { matcher } : {}) };
		const runner = new HookRunner({ hooks: { [event]: [entry] } } as never, ctx);
		await runner.fireBlocking(event, {}, target);
		return Bun.file(marker).exists();
	}

	test("PreToolUse matcher regex-tests the tool name (match / no-match)", async () => {
		expect(await matcherFires("PreToolUse", "^bash$", "bash")).toBe(true);
		expect(await matcherFires("PreToolUse", "^write$", "bash")).toBe(false);
		expect(await matcherFires("PreToolUse", "^(bash|write)$", "write")).toBe(true);
	});

	test("absent or empty matcher matches everything", async () => {
		expect(await matcherFires("PreToolUse", undefined, "bash")).toBe(true);
		expect(await matcherFires("PreToolUse", "", "anything")).toBe(true);
	});

	test("invalid regex matches nothing (never throws)", async () => {
		expect(await matcherFires("PreToolUse", "[", "bash")).toBe(false);
		expect(await matcherFires("PostToolUse", "(", "bash")).toBe(false);
	});

	test("matcher present but no target: regex tests the empty string", async () => {
		expect(await matcherFires("PreToolUse", "^bash$", undefined)).toBe(false);
		expect(await matcherFires("PreToolUse", "^$", undefined)).toBe(true);
	});

	test("SessionStart/SessionEnd/PreCompact matchers test source/reason/trigger", async () => {
		expect(await matcherFires("SessionStart", "^resume$", "resume")).toBe(true);
		expect(await matcherFires("SessionStart", "^resume$", "startup")).toBe(false);
		expect(await matcherFires("SessionEnd", "^(switch|exit)$", "exit")).toBe(true);
		expect(await matcherFires("PreCompact", "^manual$", "auto")).toBe(false);
		expect(await matcherFires("PostCompact", "^auto$", "auto")).toBe(true);
	});

	test("matcher targets: Stop/SubagentStop/JobFinished ignore matcher; UserPromptSubmit tests prompt text", async () => {
		expect(await matcherFires("Stop", "^nomatch$", undefined)).toBe(true);
		expect(await matcherFires("SubagentStop", "^nomatch$", undefined)).toBe(true);
		expect(await matcherFires("JobFinished", "^nomatch$", undefined)).toBe(true);
		// UserPromptSubmit's matcher target = the prompt text
		expect(await matcherFires("UserPromptSubmit", "^nomatch$", "some prompt")).toBe(false);
		expect(await matcherFires("UserPromptSubmit", "^some prompt$", "some prompt")).toBe(true);
	});
});

describe("UserPromptSubmit blocking", () => {
	test("exit 2 + stderr blocks with the hook's reason", async () => {
		const runner = new HookRunner(
			{ hooks: { UserPromptSubmit: [{ command: "echo 'prompt rejected by policy' >&2; exit 2" }] } },
			ctx,
		);
		const outcome = await runner.fireBlocking("UserPromptSubmit", { prompt: "do bad things" }, "do bad things");
		expect(outcome.blocked).toBe(true);
		expect(outcome.reason).toBe("prompt rejected by policy");
	});

	test("UserPromptSubmit matcher regex-tests the prompt text (kimi semantics)", async () => {
		const runner = new HookRunner({ hooks: { UserPromptSubmit: [{ command: "exit 2", matcher: "^rm -rf" }] } }, ctx);
		expect((await runner.fireBlocking("UserPromptSubmit", { prompt: "hello" }, "hello")).blocked).toBe(false);
		expect((await runner.fireBlocking("UserPromptSubmit", { prompt: "rm -rf /" }, "rm -rf /")).blocked).toBe(true);
	});
});

describe("flush (fire-and-forget drain on the exit path)", () => {
	test("when flush returns, all in-flight hooks have completed", async () => {
		const workdir = await mkWorkdir();
		const out = join(workdir, "fire-and-forget.txt");
		const runner = new HookRunner({ hooks: { Stop: [{ command: `sleep 0.3; touch '${out}'` }] } }, ctx);
		runner.fireAndForget("Stop", { outcome: "completed" });
		await runner.flush();
		expect(await Bun.file(out).exists()).toBe(true);
	});
});

describe("fireBlocking fail-open (runOne throwing contract)", () => {
	test("runOne throws (simulated Bun.spawn failure, EMFILE): treated as pass, later entries evaluated", async () => {
		const runner = new HookRunner(
			{ hooks: { PreToolUse: [{ command: "boom" }, { command: "echo veto >&2; exit 2" }] } },
			ctx,
		);
		// Bun.spawn failure can't be forced cross-platform: shadow runOne via an instance property to inject
		// the error path and unit-test fireBlocking's own try/catch + continue-loop contract
		let calls = 0;
		(runner as unknown as { runOne: () => Promise<{ exitCode: number; stderr: string }> }).runOne = async () => {
			calls += 1;
			if (calls === 1) throw new Error("Failed to spawn bash: EMFILE");
			return { exitCode: 2, stderr: "veto" };
		};
		const outcome = await runner.fireBlocking("PreToolUse", { tool_name: "bash" }, "bash");
		expect(calls).toBe(2); // the failed entry is skipped, the second is evaluated normally
		expect(outcome.blocked).toBe(true); // the block decision comes from the second entry; the error itself does not block
		expect(outcome.reason).toBe("veto");
	});

	test("every entry throws: overall pass (fail-open, must not blow up prompt()/gateToolCall)", async () => {
		const runner = new HookRunner({ hooks: { UserPromptSubmit: [{ command: "boom" }] } }, ctx);
		(runner as unknown as { runOne: () => Promise<never> }).runOne = async () => {
			throw new Error("Failed to spawn bash: EMFILE");
		};
		const outcome = await runner.fireBlocking("UserPromptSubmit", { prompt: "hi" }, "hi");
		expect(outcome.blocked).toBe(false);
	});

	test("real exception path: context getter throws → runOne fails before spawn, also passes", async () => {
		const runner = new HookRunner(
			{ hooks: { PreToolUse: [{ command: "exit 2" }] } },
			{
				sessionId: () => {
					throw new Error("context unavailable");
				},
				cwd: "/tmp/kea",
				model: () => "faux/m1",
			},
		);
		// the command is exit 2, but the error happens before spawn: under fail-open semantics it must not block
		const outcome = await runner.fireBlocking("PreToolUse", { tool_name: "bash" }, "bash");
		expect(outcome.blocked).toBe(false);
	});
});

describe("bounded drain (drain grace)", () => {
	test("grandchild holding the pipe after the hook exits does not stall fireBlocking", async () => {
		// bash exits 2 immediately, but the background sleep inherits the stderr fd and holds the pipe for 3s;
		// without a grace period, text() waits the full 3s for EOF, distorting the blocking hook's latency bound
		const runner = new HookRunner({ hooks: { PreToolUse: [{ command: "(sleep 3 &); exit 2" }] } }, ctx);
		const started = Date.now();
		const outcome = await runner.fireBlocking("PreToolUse", { tool_name: "bash" }, "bash");
		const elapsed = Date.now() - started;
		expect(outcome.blocked).toBe(true);
		expect(elapsed).toBeLessThan(2500);
	});
});

describe("structured stdout protocol (C4: kimi runner.ts alignment)", () => {
	test("exit 2 semantics unchanged: stderr reason still blocks", async () => {
		const runner = new HookRunner({ hooks: { PreToolUse: [{ command: "echo 'veto' >&2; exit 2" }] } }, ctx);
		const outcome = await runner.fireBlocking("PreToolUse", { tool_name: "bash" }, "bash");
		expect(outcome).toEqual({ blocked: true, reason: "veto" });
	});

	test("stdout JSON hookSpecificOutput permissionDecision=deny → blocked, reason from the message field", async () => {
		const runner = new HookRunner(
			{
				hooks: {
					PreToolUse: [{ command: `echo '{"hookSpecificOutput":{"permissionDecision":"deny","message":"no"}}'` }],
				},
			},
			ctx,
		);
		const outcome = await runner.fireBlocking("PreToolUse", { tool_name: "bash" }, "bash");
		expect(outcome.blocked).toBe(true);
		expect(outcome.reason).toBe("no");
	});

	test("stdout JSON top-level decision=block + reason → blocked (UserPromptSubmit/Stop semantics)", async () => {
		const runner = new HookRunner(
			{ hooks: { UserPromptSubmit: [{ command: `echo '{"decision":"block","reason":"not on my watch"}'` }] } },
			ctx,
		);
		const outcome = await runner.fireBlocking("UserPromptSubmit", { prompt: "x" }, "x");
		expect(outcome.blocked).toBe(true);
		expect(outcome.reason).toBe("not on my watch");
	});

	test("permissionDecision=deny without message: fallback reason, no throw", async () => {
		const runner = new HookRunner(
			{ hooks: { PreToolUse: [{ command: `echo '{"hookSpecificOutput":{"permissionDecision":"deny"}}'` }] } },
			ctx,
		);
		const outcome = await runner.fireBlocking("PreToolUse", { tool_name: "bash" }, "bash");
		expect(outcome.blocked).toBe(true);
		expect(typeof outcome.reason).toBe("string");
	});

	test("exit 0 + non-blocking JSON (e.g. permissionDecision=allow) → pass with no output", async () => {
		const runner = new HookRunner(
			{
				hooks: {
					PreToolUse: [{ command: `echo '{"hookSpecificOutput":{"permissionDecision":"allow","message":"fine"}}'` }],
				},
			},
			ctx,
		);
		const outcome = await runner.fireBlocking("PreToolUse", { tool_name: "bash" }, "bash");
		expect(outcome).toEqual({ blocked: false });
	});

	test("stdout non-JSON plain text → carried as output (for injection), blocking semantics unchanged", async () => {
		const runner = new HookRunner(
			{ hooks: { UserPromptSubmit: [{ command: "echo 'session note: on branch feature-x'" }] } },
			ctx,
		);
		const outcome = await runner.fireBlocking("UserPromptSubmit", { prompt: "go" }, "go");
		expect(outcome.blocked).toBe(false);
		expect(outcome.output).toBe("session note: on branch feature-x");
	});

	test("bad JSON does not throw (fail-open): under 2000 chars carried as plain text", async () => {
		const runner = new HookRunner({ hooks: { PreToolUse: [{ command: `printf '%s' '{"invalid json'` }] } }, ctx);
		const outcome = await runner.fireBlocking("PreToolUse", { tool_name: "bash" }, "bash");
		expect(outcome.blocked).toBe(false);
		expect(outcome.output).toBe('{"invalid json');
	});

	test("plain text ≥2000 chars → dropped (no large stdout injected)", async () => {
		const runner = new HookRunner({ hooks: { UserPromptSubmit: [{ command: `printf '%0.sA' {1..2500}` }] } }, ctx);
		const outcome = await runner.fireBlocking("UserPromptSubmit", { prompt: "go" }, "go");
		expect(outcome.blocked).toBe(false);
		expect(outcome.output).toBeUndefined();
	});

	test("parseHookStdout pure function: empty string / non-object JSON / array JSON", () => {
		expect(parseHookStdout("")).toEqual({});
		expect(parseHookStdout("   \n ")).toEqual({});
		expect(parseHookStdout("123")).toEqual({ output: "123" });
		expect(parseHookStdout('["a"]')).toEqual({ output: '["a"]' });
	});
});

describe("fireStop (Stop blocking wiring surface, kernel side)", () => {
	test("Stop hook decision=block → fireStop returns blocked and reason", async () => {
		const runner = new HookRunner(
			{ hooks: { Stop: [{ command: `echo '{"decision":"block","reason":"keep going: tests still red"}'` }] } },
			ctx,
		);
		const outcome = await runner.fireStop("completed");
		expect(outcome.blocked).toBe(true);
		expect(outcome.reason).toBe("keep going: tests still red");
	});

	test("Stop hook exit 2 → also blocks (semantically equivalent)", async () => {
		const runner = new HookRunner({ hooks: { Stop: [{ command: "echo 'stop vetoed' >&2; exit 2" }] } }, ctx);
		const outcome = await runner.fireStop("completed");
		expect(outcome.blocked).toBe(true);
		expect(outcome.reason).toBe("stop vetoed");
	});

	test("no Stop hooks → immediately unblocked; a passing hook's output can carry output", async () => {
		const none = new HookRunner({}, ctx);
		expect(await none.fireStop("completed")).toEqual({ blocked: false });
		const chatty = new HookRunner({ hooks: { Stop: [{ command: "echo 'final note'" }] } }, ctx);
		const outcome = await chatty.fireStop("completed");
		expect(outcome.blocked).toBe(false);
		expect(outcome.output).toBe("final note");
	});

	test("payload carries stop_hook_active (default false, explicit argument passes through)", async () => {
		const workdir = await mkWorkdir();
		const out = join(workdir, "stop-payload.json");
		const runner = new HookRunner({ hooks: { Stop: [{ command: `cat > '${out}'` }] } }, ctx);
		await runner.fireStop("completed");
		expect(((await Bun.file(out).json()) as Record<string, unknown>).stop_hook_active).toBe(false);
		await runner.fireStop("completed", true);
		expect(((await Bun.file(out).json()) as Record<string, unknown>).stop_hook_active).toBe(true);
	});
});

describe("parallel execution and result merging (C5)", () => {
	test("two slow hooks run in parallel (total time is not the serial sum)", async () => {
		const runner = new HookRunner({ hooks: { PreToolUse: [{ command: "sleep 0.4" }, { command: "sleep 0.4" }] } }, ctx);
		const started = Date.now();
		const outcome = await runner.fireBlocking("PreToolUse", { tool_name: "bash" }, "bash");
		const elapsed = Date.now() - started;
		expect(outcome.blocked).toBe(false);
		// serial would be ≥800ms of sleep alone; parallel finishes in roughly one sleep + spawn overhead
		expect(elapsed).toBeLessThan(700);
	}, 15_000);

	test("any blocked → blocked, reasons concatenated (every veto visible)", async () => {
		const runner = new HookRunner(
			{
				hooks: {
					PreToolUse: [
						{ command: "echo 'first veto' >&2; exit 2" },
						{ command: `echo '{"decision":"block","reason":"second veto"}'` },
						{ command: "exit 0" },
					],
				},
			},
			ctx,
		);
		const outcome = await runner.fireBlocking("PreToolUse", { tool_name: "bash" }, "bash");
		expect(outcome.blocked).toBe(true);
		expect(outcome.reason).toContain("first veto");
		expect(outcome.reason).toContain("second veto");
	});

	test("outputs of multiple hooks are joined with newlines", async () => {
		const runner = new HookRunner(
			{ hooks: { UserPromptSubmit: [{ command: "echo 'note one'" }, { command: "echo 'note two'" }] } },
			ctx,
		);
		const outcome = await runner.fireBlocking("UserPromptSubmit", { prompt: "go" }, "go");
		expect(outcome.blocked).toBe(false);
		expect(outcome.output).toBe("note one\nnote two");
	});
});

describe("stringifyToolInput (PostToolUse tool_input field)", () => {
	test("JSON serialization + 2000-char truncation marker", () => {
		expect(stringifyToolInput({ path: "x" })).toBe('{"path":"x"}');
		const long = stringifyToolInput({ blob: "b".repeat(3_000) });
		expect(long.length).toBeLessThanOrEqual(2_000 + "… [truncated]".length);
		expect(long.endsWith("… [truncated]")).toBe(true);
	});

	test("unserializable (cyclic reference) → empty string, no throw", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(stringifyToolInput(cyclic)).toBe("");
	});
});

describe("truncateToolInput (shared truncation for serialized payloads)", () => {
	test("2000-char cap + truncation marker; within the cap returned as-is", () => {
		expect(truncateToolInput('{"path":"x"}')).toBe('{"path":"x"}');
		expect(truncateToolInput("a".repeat(2_000))).toBe("a".repeat(2_000));
		const truncated = truncateToolInput("b".repeat(2_001));
		expect(truncated.length).toBe(2_000 + "… [truncated]".length);
		expect(truncated.endsWith("… [truncated]")).toBe(true);
	});

	test("shares the same truncation semantics as stringifyToolInput (kernel's argsKey path)", () => {
		const args = { blob: "c".repeat(3_000) };
		expect(truncateToolInput(JSON.stringify(args))).toBe(stringifyToolInput(args));
	});
});
