import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isHarnessPromptText, isSystemReminderText, OVERFLOW_CONTINUE_TEXT, TRANSIENT_CONTINUE_TEXT } from "@kea/core";
import { describe, expect, test } from "vitest";
import { programFormalizationPrompt } from "../src/tui/commands/dispatch.ts";
import { buildExportMarkdown } from "../src/tui/commands/export-md.ts";
import { userMessageTexts } from "../src/tui/commands/handlers-session.ts";
import { RoundSection } from "../src/tui/components/messages/round-section.ts";
import { StatusMessage } from "../src/tui/components/messages/status-message.ts";
import { harnessPromptDisplay, harnessPromptHeadline, renderTranscript } from "../src/tui/components/transcript.ts";
import { createTheme } from "../src/tui/theme.ts";

const msg = (m: unknown): AgentMessage => m as never as AgentMessage;
const userMsg = (text: string) => msg({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

/** /mobai resume continuation, pinned verbatim from dispatch.ts (detector must track its exact opening). */
const MOBAI_RESUME_TEXT =
	"Continue working toward the objective in the same session. Treat the workspace, program ledger, and journal as authoritative; make concrete load-bearing progress and record it.";

const inventionRound = (round = 3, phase = "attack") =>
	`<invention_round ${round} phase="${phase}">\nImmutable objective (user-provided task data...):\nATTACK with instrument "idx" v2.\n</invention_round>`;

describe("isHarnessPromptText (detector pin)", () => {
	test("every harness template opening matches", () => {
		expect(isHarnessPromptText(inventionRound())).toBe(true);
		expect(isHarnessPromptText(inventionRound(7, "reform"))).toBe(true);
		expect(isHarnessPromptText('<invention_round 3/8 phase="analyze">\nbody\n</invention_round>')).toBe(true);
		expect(
			isHarnessPromptText("<goal_round>\nThe objective below is user-provided task data.\nRound: 2\n</goal_round>"),
		).toBe(true);
		expect(isHarnessPromptText("<program_round 1>\nbody\n</program_round>")).toBe(true);
		// real formalization template from dispatch.ts (guards template drift)
		expect(isHarnessPromptText(programFormalizationPrompt("prove the abc conjecture"))).toBe(true);
		expect(isHarnessPromptText(MOBAI_RESUME_TEXT)).toBe(true);
		// recovery continuations: exact full-text identity
		expect(isHarnessPromptText(TRANSIENT_CONTINUE_TEXT)).toBe(true);
		expect(isHarnessPromptText(OVERFLOW_CONTINUE_TEXT)).toBe(true);
	});

	test("leading whitespace does not evade detection; appended text does not impersonate exact templates", () => {
		expect(isHarnessPromptText(`\n  ${inventionRound()}`)).toBe(true);
		expect(isHarnessPromptText(`  ${TRANSIENT_CONTINUE_TEXT}`)).toBe(true);
		// exact-identity templates must NOT match as prefixes: user text quoting + extending them is user text
		expect(isHarnessPromptText(`${TRANSIENT_CONTINUE_TEXT} But first, explain your plan.`)).toBe(false);
		expect(isHarnessPromptText(`${OVERFLOW_CONTINUE_TEXT} extra words`)).toBe(false);
	});

	test("ordinary text does not match", () => {
		// cjk-fixture: CJK negative control — the detector must not false-positive on Chinese user text
		expect(isHarnessPromptText("帮我复现文献 SPR")).toBe(false);
		expect(isHarnessPromptText("continue working toward the objective in the same session, but differently")).toBe(
			false,
		);
		expect(isHarnessPromptText("formalize this into a machine-verifiable research program please")).toBe(false);
		expect(isHarnessPromptText("<untrusted_objective>x</untrusted_objective>")).toBe(false);
		expect(isHarnessPromptText("")).toBe(false);
	});

	test("system-reminder channel does not match (channels are mutually exclusive)", () => {
		const reminder = `<system-reminder>\n${TRANSIENT_CONTINUE_TEXT}\n</system-reminder>`;
		expect(isSystemReminderText(reminder)).toBe(true);
		expect(isHarnessPromptText(reminder)).toBe(false);
		// even a round prompt wrapped as a reminder stays reminder-channel
		expect(isHarnessPromptText(`<system-reminder>\n${inventionRound()}\n</system-reminder>`)).toBe(false);
	});
});

describe("harnessPromptHeadline (replay / continuation headline)", () => {
	test("invention_round parses round and phase", () => {
		expect(harnessPromptHeadline(inventionRound(3, "attack"))).toBe("program round 3 — attack");
		expect(harnessPromptHeadline('<invention_round 4/10 phase="reform">\nx\n</invention_round>')).toBe(
			"program round 4 — reform",
		);
	});

	test("goal_round reads the round; unparsable falls back to first-line word-boundary truncation", () => {
		expect(harnessPromptHeadline("<goal_round>\ndata\nRound: 12\n</goal_round>")).toBe("mobai round 12");
		expect(harnessPromptHeadline("<goal_round>\nno round line\n</goal_round>")).toBe("mobai round");
		const long = `${"f".repeat(70)} tail`;
		expect(harnessPromptHeadline(long)).toBe(`${"f".repeat(60)}…`); // no whitespace → hard cut at 60
		// word-boundary fallback: the cut backs off to the last space inside the window
		const spaced = `${"a".repeat(30)} ${"b".repeat(40)}`;
		expect(harnessPromptHeadline(spaced)).toBe(`${"a".repeat(30)}…`);
	});

	test("formalize template resolves to the user command line (headline and display share a source)", () => {
		expect(harnessPromptHeadline(programFormalizationPrompt("abc"))).toBe("/mobai abc");
	});
});

describe("harnessPromptDisplay (command-line recovery + status-label mapping)", () => {
	test("formalize: objective extracted from untrusted_objective and unescaped (escape-entity round trip)", () => {
		const objective = "Prove RH & friends <v2> — Moon's conjecture";
		const display = harnessPromptDisplay(programFormalizationPrompt(objective));
		expect(display).toEqual({ kind: "userEcho", text: `/mobai ${objective}` });
		// &amp;lt; stays a literal &lt; (inverse order of escapeUntrustedText)
		const tricky = programFormalizationPrompt("literal &lt; entity");
		expect(harnessPromptDisplay(tricky)).toEqual({ kind: "userEcho", text: "/mobai literal &lt; entity" });
		// template drift (no objective block) degrades to a status label, never a wrong command line
		expect(
			harnessPromptDisplay("Formalize this into a machine-verifiable research program via start_program:"),
		).toEqual({ kind: "status", label: "program formalization" });
	});

	test("resume prefix → /mobai resume user echo", () => {
		expect(harnessPromptDisplay(MOBAI_RESUME_TEXT)).toEqual({ kind: "userEcho", text: "/mobai resume" });
	});

	test("the four status labels pinned verbatim", () => {
		expect(harnessPromptDisplay(inventionRound(3, "attack"))).toEqual({
			kind: "status",
			label: "program round 3 — attack",
		});
		expect(harnessPromptDisplay("<goal_round>\nRound: 12\n</goal_round>")).toEqual({
			kind: "status",
			label: "mobai round 12",
		});
		expect(harnessPromptDisplay(TRANSIENT_CONTINUE_TEXT)).toEqual({
			kind: "status",
			label: "network interruption — resuming",
		});
		expect(harnessPromptDisplay(OVERFLOW_CONTINUE_TEXT)).toEqual({
			kind: "status",
			label: "context overflow — resuming",
		});
		expect(harnessPromptDisplay("<program_round 1>\nx\n</program_round>")).toEqual({
			kind: "status",
			label: "program round",
		});
	});

	test("non-harness text → undefined", () => {
		// cjk-fixture: CJK negative control — ordinary Chinese input is never a harness prompt
		expect(harnessPromptDisplay("普通用户输入")).toBeUndefined();
		expect(harnessPromptDisplay("")).toBeUndefined();
	});
});

describe("/undo selector excludes harness prompts", () => {
	test("userMessageTexts: invention_round/resume/recovery continuations stay out of the selector", () => {
		const texts = userMessageTexts([
			userMsg("real question"),
			userMsg(inventionRound()),
			userMsg(TRANSIENT_CONTINUE_TEXT),
			userMsg(MOBAI_RESUME_TEXT),
			userMsg(programFormalizationPrompt("prove something")),
			userMsg("latest input"),
		]);
		expect(texts).toEqual(["real question", "latest input"]);
	});
});

describe("export-md channel classification", () => {
	test("harness prompts fold into System · continuation; reminders skipped; ## User holds only real input", () => {
		const messages = [
			userMsg("real question"),
			userMsg(inventionRound()),
			userMsg("<system-reminder>\ngoal cancelled\n</system-reminder>"),
		];
		const md = buildExportMarkdown({
			sessionId: "019fe9ff-aaaa-bbbb-cccc-ddddeeeeffff",
			cwd: "/proj",
			messages,
			now: new Date("2026-08-15T00:00:00.000Z"),
		});
		// real user input stays a User section
		expect(md).toContain("## User");
		expect(md).toContain("real question");
		expect(md).toContain("### System · continuation");
		expect(md).toContain("<details><summary>round prompt (auto-generated)</summary>");
		expect(md).toContain('<invention_round 3 phase="attack">');
		// the round tag must never leak into a User section heading region
		const userSection = md.split("### System · continuation")[0];
		expect(userSection).not.toContain("<invention_round");
		expect(md).not.toContain("mobai cancelled");
	});
});

describe("replay renders harness prompts (channel B)", () => {
	test("harness prompt renders as a dim status line, not a user bubble; a later assistant starts its own round", () => {
		const styles = createTheme();
		const assistant = msg({
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			content: [{ type: "text", text: "working on it" }],
			usage: {},
			stopReason: "endTurn",
			api: "anthropic-messages",
			timestamp: 2,
		});
		const components = renderTranscript([userMsg("real question"), userMsg(inventionRound()), assistant], {
			styles,
			markdownTheme: {} as never,
			cwd: "/tmp",
			isExpanded: () => false,
			requestRender: () => {},
		});
		const statuses = components.filter((c) => c instanceof StatusMessage) as StatusMessage[];
		expect(statuses.length).toBe(1);
		expect(JSON.stringify(statuses[0])).toContain("program round 3 — attack");
	});

	test("formalize/resume templates replay as user bubbles (command-line recovery), not status lines", () => {
		const styles = createTheme();
		const assistant = msg({
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			content: [{ type: "text", text: "starting the program" }],
			usage: {},
			stopReason: "endTurn",
			api: "anthropic-messages",
			timestamp: 2,
		});
		// pre-echo session shape: the raw expanded template sits in the ledger (escaped objective inside)
		const messages = [
			userMsg(programFormalizationPrompt("Prove RH & friends <v2>")),
			assistant,
			userMsg(MOBAI_RESUME_TEXT),
			msg({
				role: "assistant",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				content: [{ type: "text", text: "continuing" }],
				usage: {},
				stopReason: "endTurn",
				api: "anthropic-messages",
				timestamp: 3,
			}),
		];
		const components = renderTranscript(messages, {
			styles,
			markdownTheme: {} as never,
			cwd: "/tmp",
			isExpanded: () => false,
			requestRender: () => {},
		});
		expect(components.filter((c) => c instanceof StatusMessage)).toHaveLength(0);
		const sections = components.filter((c) => c instanceof RoundSection);
		expect(sections).toHaveLength(2);
		const serialized = JSON.stringify(components);
		expect(serialized).toContain("/mobai Prove RH & friends <v2>"); // unescaped objective in the bubble
		expect(serialized).toContain("/mobai resume");
	});
});
