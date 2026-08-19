import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kernel } from "@kea/core";
import { saveMobaiIn } from "@kea/research";
import { describe, expect, test } from "vitest";
import { completeLeadingArg } from "../src/tui/commands/complete-args.ts";
import { dispatchInput } from "../src/tui/commands/dispatch.ts";
import { parseSlashInput } from "../src/tui/commands/parse.ts";
import { BUILTIN_COMMANDS, findBuiltinCommand, sortCommands, suggestCommand } from "../src/tui/commands/registry.ts";
import { resolveSlashCommandInput } from "../src/tui/commands/resolve.ts";
import type { KeaSlashCommand, SlashCommandHost } from "../src/tui/commands/types.ts";
import { sessionMobaiDir } from "../src/tui/mobai-dir.ts";

describe("slash parse (M1)", () => {
	test("splits name and args on first space", () => {
		expect(parseSlashInput("/model anthropic/x")).toEqual({ name: "model", args: "anthropic/x" });
		expect(parseSlashInput("/help")).toEqual({ name: "help", args: "" });
		expect(parseSlashInput("  /mobai do things")).toEqual({ name: "mobai", args: "do things" });
	});

	test("rejects non-commands and path-like input", () => {
		expect(parseSlashInput("hello")).toBeUndefined();
		expect(parseSlashInput("/usr/local/bin")).toBeUndefined();
		expect(parseSlashInput("")).toBeUndefined();
	});

	test("trailing spaces after the subcommand are trimmed (`/model add ` still hits add)", () => {
		expect(parseSlashInput("/model add ")).toEqual({ name: "model", args: "add" });
		expect(parseSlashInput("/model add   ")).toEqual({ name: "model", args: "add" });
		expect(parseSlashInput("/mobai do things  ")).toEqual({ name: "mobai", args: "do things" });
	});

	test("multi-line drafts never become commands: only line-0 leading spaces/tabs are stripped", () => {
		expect(parseSlashInput("\n/mobai x")).toBeUndefined();
		expect(parseSlashInput("note\n/mobai x")).toBeUndefined();
		expect(parseSlashInput("  /mobai x")).toEqual({ name: "mobai", args: "x" });
	});
});

describe("slash resolve (M1)", () => {
	test("matches name and aliases", () => {
		expect(resolveSlashCommandInput("/h", undefined)).toMatchObject({ kind: "builtin", name: "help" });
		expect(resolveSlashCommandInput("/?", undefined)).toMatchObject({ kind: "builtin", name: "help" });
		expect(resolveSlashCommandInput("/cost", undefined)).toMatchObject({ kind: "builtin", name: "usage" });
	});

	test("idle-only commands are blocked while streaming", () => {
		const blocked = resolveSlashCommandInput("/new", "streaming");
		expect(blocked).toMatchObject({ kind: "blocked", commandName: "new", reason: "streaming" });
		const fine = resolveSlashCommandInput("/new", undefined);
		expect(fine.kind).toBe("builtin");
	});

	test("unknown commands suggest did-you-mean", () => {
		const invalid = resolveSlashCommandInput("/modle x", undefined);
		expect(invalid).toMatchObject({ kind: "invalid", commandName: "modle", suggestion: "model" });
	});

	test("unknown commands without close match stay invalid without suggestion", () => {
		const invalid = resolveSlashCommandInput("/zzzzzz", undefined);
		expect(invalid.kind).toBe("invalid");
		expect((invalid as { suggestion?: string }).suggestion).toBeUndefined();
	});

	test("missing availability defaults to idle-only (kimi parity)", () => {
		expect(resolveSlashCommandInput("/copy", "streaming").kind).toBe("blocked");
		expect(resolveSlashCommandInput("/copy", undefined).kind).toBe("builtin");
	});

	test("/exit and /quit stay available anytime (kimi allows exiting mid-stream)", () => {
		expect(resolveSlashCommandInput("/exit", "streaming")).toMatchObject({ kind: "builtin", name: "exit" });
		expect(resolveSlashCommandInput("/quit", "streaming")).toMatchObject({ kind: "builtin", name: "exit" });
		expect(resolveSlashCommandInput("/q", "streaming")).toMatchObject({ kind: "builtin", name: "exit" });
		expect(resolveSlashCommandInput("/exit", undefined).kind).toBe("builtin");
	});

	test("/yolo and /help stay available mid-stream", () => {
		expect(resolveSlashCommandInput("/yolo on", "streaming")).toMatchObject({ kind: "builtin", name: "yolo" });
		expect(resolveSlashCommandInput("/help", "streaming")).toMatchObject({ kind: "builtin", name: "help" });
	});

	test("/provider opens the manager and stays available mid-stream (manager self-guards)", async () => {
		let opened = 0;
		const host = fakeHost({ openProviderManager: () => (opened += 1) });
		const idle = await dispatchInput(host, { agent: { state: { messages: [] } } } as unknown as Kernel, "/provider");
		expect(idle.handled).toBe(true);
		expect(opened).toBe(1);

		expect(resolveSlashCommandInput("/provider", "streaming").kind).toBe("builtin");
	});

	test("/model add routes to the custom add-provider flow and is busy-refused mid-stream", async () => {
		const calls: Array<boolean | undefined> = [];
		const host = fakeHost({ runAddProviderFlow: (customDirect?: boolean) => calls.push(customDirect) });
		const result = await dispatchInput(host, { agent: { state: { messages: [] } } } as unknown as Kernel, "/model add");
		expect(result.handled).toBe(true);
		expect(calls).toEqual([true]);
		const trailing = await dispatchInput(
			host,
			{ agent: { state: { messages: [] } } } as unknown as Kernel,
			"/model add ",
		);
		expect(trailing.handled).toBe(true);
		expect(calls).toEqual([true, true]);
		const upper = await dispatchInput(host, { agent: { state: { messages: [] } } } as unknown as Kernel, "/model ADD");
		expect(upper.handled).toBe(true);
		expect(calls).toEqual([true, true, true]);
		expect(resolveSlashCommandInput("/model add", "streaming")).toMatchObject({
			kind: "blocked",
			commandName: "model",
		});
		expect(resolveSlashCommandInput("/model ADD", "streaming")).toMatchObject({
			kind: "blocked",
			commandName: "model",
		});
		expect(resolveSlashCommandInput("/model", "streaming").kind).toBe("builtin");
	});

	test("availability table: mid-stream-safe commands always, session-mutating idle-only", () => {
		const always = [
			"help",
			"model",
			"effort",
			"settings",
			"yolo",
			"auto",
			"permission",
			"plan",
			"mcp",
			"tasks",
			"context",
			"doctor",
			"mobai",
			"exit",
			"title",
			"usage",
			"status",
			"version",
			"provider",
		];
		for (const name of always) {
			expect(resolveSlashCommandInput(`/${name}`, "streaming").kind, `/${name} mid-stream`).toBe("builtin");
		}
		const idleOnly = ["undo", "fork", "new", "sessions", "compact", "reload", "copy", "export-md", "export-debug-zip"];
		for (const name of idleOnly) {
			expect(resolveSlashCommandInput(`/${name}`, "streaming").kind, `/${name} mid-stream`).toBe("blocked");
		}
	});

	test("/mobai resume is idle-only (kernel.prompt re-entrancy guard); pause/status stay mid-stream-safe", () => {
		expect(resolveSlashCommandInput("/mobai resume", "streaming")).toMatchObject({
			kind: "blocked",
			commandName: "mobai",
		});
		expect(resolveSlashCommandInput("/mobai pause", "streaming").kind).toBe("builtin");
		expect(resolveSlashCommandInput("/mobai", "streaming").kind).toBe("builtin");
	});
});

describe("autocomplete rules (M1)", () => {
	test("completeLeadingArg: prefix match, stop after space, stop on unique exact", () => {
		const specs = ["status", "pause", "resume"];
		expect(completeLeadingArg(specs, "s")?.map((i) => i.value)).toEqual(["status"]);
		expect(completeLeadingArg(specs, "")).toHaveLength(3);
		expect(completeLeadingArg(specs, "status ")).toBeNull();
		expect(completeLeadingArg(specs, "status")).toBeNull();
		expect(completeLeadingArg(specs, "re")?.map((i) => i.value)).toEqual(["resume"]);
	});
});

describe("registry (M1)", () => {
	test("all P0 M1 commands registered", () => {
		const names = BUILTIN_COMMANDS.map((c) => c.name);
		for (const required of [
			"help",
			"model",
			"provider",
			"effort",
			"settings",
			"new",
			"sessions",
			"title",
			"compact",
			"copy",
			"usage",
			"status",
			"version",
			"reload",
			"exit",
		]) {
			expect(names).toContain(required);
		}
	});

	test("sortCommands orders by priority desc, then name; /yolo pinned first", () => {
		const sorted = sortCommands(BUILTIN_COMMANDS as readonly KeaSlashCommand[]);
		expect(sorted[0]?.name).toBe("yolo");
		const priorities = sorted.map((c) => c.priority ?? 0);
		for (let i = 1; i < priorities.length; i++) {
			expect(priorities[i - 1] as number).toBeGreaterThanOrEqual(priorities[i] as number);
		}
	});

	test("commands without priority sink to the bottom (kimi default-0 semantics)", () => {
		const noPriority = { name: "zz-custom", aliases: [], description: "x" } as KeaSlashCommand;
		const sorted = sortCommands([noPriority, ...(BUILTIN_COMMANDS as readonly KeaSlashCommand[])]);
		expect(sorted.at(-1)?.name).toBe("zz-custom");
	});

	test("findBuiltinCommand resolves aliases", () => {
		expect(findBuiltinCommand("q")?.name).toBe("exit");
		expect(findBuiltinCommand("config")?.name).toBe("settings");
		expect(findBuiltinCommand("nope")).toBeUndefined();
	});

	test("effort command exposes subcommand completions", () => {
		const effort = findBuiltinCommand("effort");
		const completions = effort?.completeArgs?.("me") ?? null;
		expect(completions?.map((c) => c.value)).toEqual(["medium"]);
	});

	test("M2 mode commands registered with on/off completions", () => {
		for (const name of ["yolo", "auto", "permission", "plan", "mcp"]) {
			expect(findBuiltinCommand(name)?.name).toBe(name);
		}
		expect(findBuiltinCommand("yes")?.name).toBe("yolo");
		expect(
			findBuiltinCommand("yolo")
				?.completeArgs?.("o")
				?.map((c) => c.value),
		).toEqual(["on", "off"]);
		expect(
			findBuiltinCommand("permission")
				?.completeArgs?.("a")
				?.map((c) => c.value),
		).toEqual(["auto"]);
	});

	test("/mobai completions cover every dispatch subcommand, incl. next second level", () => {
		const mobai = findBuiltinCommand("mobai");
		const firstLevel = mobai?.completeArgs?.("")?.map((c) => c.value) ?? [];
		expect(firstLevel).toEqual(["status", "check", "clear", "pause", "resume", "cancel", "replace", "next"]);
		expect(mobai?.completeArgs?.("next l")?.map((c) => c.value)).toEqual(["list"]);
		expect(mobai?.completeArgs?.("next remove 2")).toBeNull();
		expect(mobai?.completeArgs?.("replace new objective")).toBeNull();
	});

	test("/plan completions include clear (synced with dispatch)", () => {
		expect(
			findBuiltinCommand("plan")
				?.completeArgs?.("")
				?.map((c) => c.value),
		).toEqual(["on", "off", "clear"]);
	});
});

describe("palette ordering (kimi priority parity)", () => {
	const signal = new AbortController().signal;

	test("empty / prefix lists /yolo first, order follows priority", async () => {
		const { SlashAwareAutocomplete } = await import("../src/tui/components/editor/slash-provider.ts");
		const provider = new SlashAwareAutocomplete(BUILTIN_COMMANDS as readonly KeaSlashCommand[], "/tmp");
		const res = await provider.getSuggestions(["/"], 0, 1, { signal });
		expect(res?.items[0]?.value).toBe("yolo");
		const names = res?.items.map((i) => i.value) ?? [];
		expect(names.indexOf("yolo")).toBeLessThan(names.indexOf("model"));
		expect(names.indexOf("model")).toBeLessThan(names.indexOf("auto"));
	});

	test("typed prefix keeps fuzzy ranking primary; equal scores fall back to priority order", async () => {
		const { SlashAwareAutocomplete } = await import("../src/tui/components/editor/slash-provider.ts");
		const provider = new SlashAwareAutocomplete(BUILTIN_COMMANDS as readonly KeaSlashCommand[], "/tmp");
		const res = await provider.getSuggestions(["/e"], 0, 2, { signal });
		const values = res?.items.map((i) => i.value) ?? [];
		expect(values).toContain("effort");
		expect(values).toContain("exit");
	});
});

describe("suggestCommand (M1)", () => {
	test("fuzzy within distance 2", () => {
		const cmds = BUILTIN_COMMANDS as readonly KeaSlashCommand[];
		expect(suggestCommand("modle", cmds)).toBe("model");
		expect(suggestCommand("helpp", cmds)).toBe("help");
		expect(suggestCommand("xxxxxxxx", cmds)).toBeUndefined();
	});
});

describe("slash-shaped input mid-stream (app.ts steer routing seam)", () => {
	test("path-shaped /usr/bin/foo is not a command while streaming: dispatch leaves it to the steer queue", async () => {
		const kernel = { agent: { state: { messages: [] as unknown[] } } };
		const host = fakeHost({ isStreaming: () => true });
		const result = await dispatchInput(host, kernel as unknown as Kernel, "/usr/bin/foo");
		expect(result.handled).toBe(false);
	});

	test("unknown command /zzzz still counts as handled (error notice shown), never enters the steer queue", async () => {
		const kernel = { agent: { state: { messages: [] as unknown[] } } };
		const errors: string[] = [];
		const host = fakeHost({ isStreaming: () => true, showError: (text: string) => errors.push(text) });
		const result = await dispatchInput(host, kernel as unknown as Kernel, "/zzzz");
		expect(result.handled).toBe(true);
		expect(errors.some((e) => e.includes("Unknown command"))).toBe(true);
	});
});

describe("usageBar/formatTokens (usage progress bar)", () => {
	test("progress bar length and percentage are correct", async () => {
		const { usageBar } = await import("../src/tui/commands/dispatch.ts");
		const { formatTokens } = await import("../src/tui/constants/format.ts");
		const bar = usageBar(50, 10);
		expect(bar).toBe("█████░░░░░ 50%");
		expect(usageBar(120, 10)).toBe("██████████ 100%");
		expect(usageBar(-5, 10)).toBe("░░░░░░░░░░ 0%");
		expect(formatTokens(15200)).toBe("15.2k");
		expect(formatTokens(1_500_000)).toBe("1.5M");
		expect(formatTokens(800)).toBe("800");
	});
});

function fakeHost(overrides: Partial<SlashCommandHost> = {}): SlashCommandHost {
	const base = {
		cwd: process.cwd(),
		isStreaming: () => false,
		isCompacting: () => false,
		showStatus: (_text: string) => {},
		showError: (_text: string) => {},
		showNotice: (_title: string, _detail?: string) => {},
		lastAssistantText: () => "",
		copyToClipboard: (_text: string) => false,
		submitPrompt: (_text: string) => {},
		openModelPicker: () => {},
		openProviderManager: () => {},
		runAddProviderFlow: (_customDirect?: boolean) => {},
		openSessionsPicker: () => {},
		openUndoSelector: (_choices: Array<{ value: string; label: string }>, _onPick: (value: string) => void) => {},
		openPermissionPicker: () => {},
		openTasksPanel: () => {},
		openHelpPanel: () => {},
		openSettingsPanel: () => {},
		openEffortPicker: () => {},
		openInfoPanel: (_title: string, _lines: string[]) => {},
		exit: () => {},
	};
	return { ...base, ...overrides } as SlashCommandHost;
}

describe("/fork (kimi-style no-switch: copies the ledger, stays in the current session)", () => {
	test("fork creates the ledger copy without switching the live session", async () => {
		const history = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "hi there" }], timestamp: 2 },
			{ role: "user", content: [{ type: "text", text: "fork me" }], timestamp: 3 },
		];
		const state = { messages: [...history] as unknown[] };
		let switchCalls = 0;
		let newSessionCalls = 0;
		const recordedPrompts: string[] = [];
		let appended: readonly unknown[] = [];
		const kernel = {
			agent: { state },
			model: { provider: "test", id: "faux" },
			session: { getMetadata: async () => ({ id: "current-session" }) },
			sessions: {
				create: async () => ({ getMetadata: async () => ({ id: "forked-session" }) }),
				readSystemPrompt: async () => "SYS",
				recordSystemPrompt: async (_s: unknown, text: string) => {
					recordedPrompts.push(text);
				},
				append: async (_s: unknown, msgs: readonly unknown[]) => {
					appended = msgs;
				},
			},
			// no-switch contract: neither switch API may be touched
			newSession: async () => {
				newSessionCalls += 1;
				return "must-not-happen";
			},
			switchSession: async () => {
				switchCalls += 1;
			},
		};
		const statuses: string[] = [];
		const host = fakeHost({ showStatus: (text: string) => statuses.push(text) });

		const result = await dispatchInput(host, kernel as unknown as Kernel, "/fork");

		expect(result.handled).toBe(true);
		expect(newSessionCalls).toBe(0);
		expect(switchCalls).toBe(0);
		expect(appended).toEqual(history); // the copy carries the full conversation
		expect(recordedPrompts).toEqual(["SYS"]); // the fork inherits the recorded system prompt
		expect(state.messages).toEqual(history); // live memory untouched — we stayed in the current session
		expect(statuses.some((s) => s.includes("Forked to"))).toBe(true);
		expect(statuses.some((s) => s.includes("use /sessions to switch"))).toBe(true);
	});

	test("fork while streaming is blocked before touching the kernel", async () => {
		const state = { messages: [] as unknown[] };
		let newSessionCalls = 0;
		const kernel = {
			agent: { state },
			newSession: async () => {
				newSessionCalls += 1;
				return "x";
			},
		};
		const errors: string[] = [];
		const host = fakeHost({
			isStreaming: () => true,
			showStatus: (text: string) => errors.push(text),
		});

		const result = await dispatchInput(host, kernel as unknown as Kernel, "/fork");

		expect(result.handled).toBe(true);
		expect(newSessionCalls).toBe(0);
		expect(errors.some((s) => s.includes("streaming"))).toBe(true);
	});
});

describe("/mobai session-scoped lifecycle", () => {
	async function seedMobai(workdir: string, sessionId: string) {
		await saveMobaiIn(sessionMobaiDir(workdir, sessionId), {
			objective: "an active mobai",
			criteria: [{ check: "file_exists", description: "d", path: "p" }],
			status: "active",
			updatedAt: Date.now(),
			frontier: [],
			progress: [],
		});
	}

	test("/mobai <objective> while the session has an active mobai rejects immediately (no prompt injection)", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "kea2-mobaicmd-"));
		try {
			await seedMobai(workdir, "s1");
			const errors: string[] = [];
			let submitted = 0;
			const host = fakeHost({
				cwd: workdir,
				showError: (text: string) => errors.push(text),
				submitPrompt: () => (submitted += 1),
			});
			const kernel = { sessionId: "s1" } as unknown as Kernel;
			const result = await dispatchInput(host, kernel, "/mobai prove something else");
			expect(result.handled).toBe(true);
			expect(submitted).toBe(0);
			expect(errors.some((e) => e.includes("already exists"))).toBe(true);
		} finally {
			await rm(workdir, { recursive: true, force: true });
		}
	});

	test("/mobai clear removes only the session mobai; then /mobai <objective> injects the formalization prompt", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "kea2-mobaicmd-"));
		try {
			await seedMobai(workdir, "s1");
			// an unrelated session's mobai must be untouched by /mobai clear in s1
			await seedMobai(workdir, "s2");
			const statuses: string[] = [];
			let submitted = 0;
			const host = fakeHost({
				cwd: workdir,
				showStatus: (text: string) => statuses.push(text),
				submitPrompt: () => (submitted += 1),
			});
			const kernel = { sessionId: "s1" } as unknown as Kernel;
			await dispatchInput(host, kernel, "/mobai clear");
			expect(statuses.some((s) => s.includes("cleared"))).toBe(true);
			await dispatchInput(host, kernel, "/mobai a fresh objective");
			expect(submitted).toBe(1);
		} finally {
			await rm(workdir, { recursive: true, force: true });
		}
	});
});
