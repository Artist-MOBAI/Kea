import type { Component } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { HookBlockedError, type Kernel } from "@kea/core";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { runMobaiLoop } from "../src/headless/mobai.ts";
import { runHeadless } from "../src/headless/run.ts";
import { KeaTUI, shutdownKernel } from "../src/tui/app.ts";
import { RoundSection } from "../src/tui/components/messages/round-section.ts";
import { WidthSafe } from "../src/tui/components/width-safe.ts";
import { classifyError, hookBlockedMessage, hookBlockedReason } from "../src/tui/controllers/error-classify.ts";
import { makeTempDir, removeTempDir } from "./helpers/temp-dir.ts";

interface KeaTUIInternals {
	onSubmit(text: string): void;
	editor: { getText(): string };
	transcript: { children: readonly Component[] };
	tui: { stop(): void };
}

function fakeKernel(prompt: (text: string) => Promise<void>): Kernel {
	return {
		approvalHandler: undefined,
		agent: { state: { isStreaming: false, messages: [] } },
		model: { provider: "test", id: "faux", contextWindow: 0 },
		sessionId: "hook-blocked-test",
		permissionMode: "manual",
		prompt,
	} as never as Kernel;
}

describe("hook block detection and wording", () => {
	test("hookBlockedReason: HookBlockedError returns the reason, other errors undefined", () => {
		expect(hookBlockedReason(new HookBlockedError("policy: no network"))).toBe("policy: no network");
		expect(hookBlockedReason(new Error("policy: no network"))).toBeUndefined();
		expect(hookBlockedReason("not an error")).toBeUndefined();
	});

	test("hookBlockedMessage wording is the single source of truth (shared by TUI/headless)", () => {
		expect(hookBlockedMessage("exit 2 from guard")).toBe("Hook blocked the prompt: exit 2 from guard");
	});

	test("classifyError does not take over hook block semantics (block path independent of the classifier)", () => {
		expect(classifyError("Hook blocked the prompt: x")).toBe("Hook blocked the prompt: x");
	});
});

describe("TUI hook block display (error status + input preserved)", () => {
	let home: string;
	let originalHome: string | undefined;

	beforeAll(async () => {
		originalHome = process.env.HOME;
		home = await makeTempDir("kea2-hook-home-");
		process.env.HOME = home;
	});

	afterAll(async () => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeTempDir(home).catch(() => {});
	});

	const internals = (app: KeaTUI): KeaTUIInternals => app as never as KeaTUIInternals;

	const transcriptChildren = (app: KeaTUI): readonly Component[] => internals(app).transcript.children;

	const renderTranscript = (app: KeaTUI): string =>
		transcriptChildren(app)
			.flatMap((child) => child.render(120))
			.map((line) => stripTerminalSequences(line))
			.join("\n");

	const hasRoundSection = (app: KeaTUI): boolean =>
		transcriptChildren(app).some((child) => {
			const inner = child instanceof WidthSafe ? child.wrapped : child;
			return inner instanceof RoundSection;
		});

	test("HookBlockedError → error status line + editor content restored + phantom round card retracted", async () => {
		const app = new KeaTUI(fakeKernel(() => Promise.reject(new HookBlockedError("policy: no network"))));
		internals(app).tui.stop();
		internals(app).onSubmit("analyze the sample");
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(internals(app).editor.getText()).toBe("analyze the sample");
		expect(renderTranscript(app)).toContain("Error: Hook blocked the prompt: policy: no network");
		expect(hasRoundSection(app)).toBe(false);
	});

	test("other prompt errors keep existing handling: editor not restored, error goes through classifyError", async () => {
		const app = new KeaTUI(fakeKernel(() => Promise.reject(new Error("401 unauthorized"))));
		internals(app).tui.stop();
		internals(app).onSubmit("try again");
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(internals(app).editor.getText()).toBe("");
		const text = renderTranscript(app);
		expect(text).toContain("401 unauthorized");
		expect(text).toContain("credentials/permission issue");
	});
});

describe("headless hook block (stderr + non-zero exit)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const silentKernelEvents = { subscribe: () => () => {} };

	const headlessKernel = () =>
		({
			events: silentKernelEvents,
			agent: { waitForIdle: async () => {}, state: { errorMessage: undefined } },
			prompt: async () => {
				throw new HookBlockedError("policy: no network");
			},
		}) as never as Kernel;

	test("run mode (text): stderr error + exit code 1", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const code = await runHeadless(headlessKernel(), { prompt: "hello", format: "text" });
		expect(code).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("error: Hook blocked the prompt: policy: no network");
	});

	test("run mode (ndjson): error event line + exit code 1", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const code = await runHeadless(headlessKernel(), { prompt: "hello", format: "ndjson" });
		expect(code).toBe(1);
		expect(logSpy).toHaveBeenCalledWith(
			JSON.stringify({ type: "error", message: "Hook blocked the prompt: policy: no network" }),
		);
	});

	test("run mode: non-hook errors keep propagating (existing behavior)", async () => {
		const kernel = {
			events: silentKernelEvents,
			agent: { waitForIdle: async () => {}, state: { errorMessage: undefined } },
			prompt: async () => {
				throw new Error("model exploded");
			},
		} as never as Kernel;
		await expect(runHeadless(kernel, { prompt: "hello", format: "text" })).rejects.toThrow("model exploded");
	});

	test("mobai mode: objective prompt blocked → outcome error (exit code semantics 1) + stderr line", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const cwd = await makeTempDir("kea2-hook-mobai-");
		try {
			const kernel = {
				agent: { waitForIdle: async () => {}, state: { errorMessage: undefined } },
				reviewMobaiCommand: () => "approve" as const,
				prompt: async () => {
					throw new HookBlockedError("guard: no mobai formalization");
				},
			} as never as Kernel;
			const report = await runMobaiLoop(kernel, { cwd, objective: "do things", maxRounds: 3, wallClockMs: 60_000 });
			expect(report.outcome).toBe("error");
			expect(report.rounds).toBe(0);
			expect(report.detail).toBe("Hook blocked the prompt: guard: no mobai formalization");
			expect(errorSpy).toHaveBeenCalledWith("error: Hook blocked the prompt: guard: no mobai formalization");
		} finally {
			await removeTempDir(cwd).catch(() => {});
		}
	});
});

describe("shutdownKernel (exit settlement: dispose(SessionEnd) → close, each with its own watchdog)", () => {
	test("dispose before close", async () => {
		const calls: string[] = [];
		await shutdownKernel(
			{
				dispose: async () => {
					calls.push("dispose");
				},
				close: async () => {
					calls.push("close");
				},
			},
			1_000,
		);
		expect(calls).toEqual(["dispose", "close"]);
	});

	test("dispose throwing does not block close (best-effort)", async () => {
		const calls: string[] = [];
		await shutdownKernel(
			{
				dispose: async () => {
					throw new Error("hook exploded");
				},
				close: async () => {
					calls.push("close");
				},
			},
			1_000,
		);
		expect(calls).toEqual(["close"]);
	});

	test("dispose hanging does not block exit: close still gets its own window", async () => {
		const calls: string[] = [];
		const startedAt = Date.now();
		await shutdownKernel(
			{
				dispose: () => new Promise<void>(() => {}),
				close: async () => {
					calls.push("close");
				},
			},
			50,
		);
		expect(calls).toEqual(["close"]);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});
});
