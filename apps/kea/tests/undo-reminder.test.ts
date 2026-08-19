import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Kernel } from "@kea/core";
import { describe, expect, test } from "vitest";
import { COMPACTION_SUMMARY_PREFIX, handleUndo, userMessageTexts } from "../src/tui/commands/handlers-session.ts";
import type { SlashCommandHost } from "../src/tui/commands/types.ts";
import { StatusMessage } from "../src/tui/components/messages/status-message.ts";
import { renderTranscript, systemReminderHeadline } from "../src/tui/components/transcript.ts";
import { createTheme } from "../src/tui/theme.ts";

const msg = (m: unknown): AgentMessage => m as never as AgentMessage;
const userMsg = (text: string) => msg({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const reminderMsg = (text: string) => userMsg(`<system-reminder>\n${text}\n</system-reminder>`);
const summaryMsg = () => userMsg(`${COMPACTION_SUMMARY_PREFIX}\nwhat happened so far`);

function mockHost(captures: {
	statuses: string[];
	errors: string[];
	choices?: Array<{ value: string; label: string }>;
}) {
	return {
		cwd: process.cwd(),
		isStreaming: () => false,
		isCompacting: () => false,
		showStatus: (t: string) => captures.statuses.push(t),
		showError: (t: string) => captures.errors.push(t),
		showNotice: () => {},
		lastAssistantText: () => "",
		copyToClipboard: () => false,
		submitPrompt: () => {},
		openModelPicker: () => {},
		openProviderManager: () => {},
		runAddProviderFlow: () => {},
		openSessionsPicker: () => {},
		openUndoSelector: (choices: Array<{ value: string; label: string }>) => {
			captures.choices = choices;
		},
		openPermissionPicker: () => {},
		openTasksPanel: () => {},
		openHelpPanel: () => {},
		openSettingsPanel: () => {},
		openEffortPicker: () => {},
		openInfoPanel: () => {},
		exit: () => {},
	} as SlashCommandHost;
}

function mockKernel(messages: AgentMessage[]): Kernel {
	return { agent: { state: { messages } } } as unknown as Kernel;
}

describe("/undo and system-reminder (B1)", () => {
	test("userMessageTexts: reminders stay out of the selector; past a compaction summary only later inputs kept", () => {
		const texts = userMessageTexts([
			userMsg("ancient input"),
			summaryMsg(),
			userMsg("after summary"),
			reminderMsg("The user cancelled the current mobai."),
			userMsg("latest input"),
		]);
		// "ancient input" sits before the compaction boundary → unreachable; the reminder never counts
		expect(texts).toEqual(["after summary", "latest input"]);
	});

	test("the selector lists only plain user inputs (no reminder/summary)", () => {
		const captures: { statuses: string[]; errors: string[]; choices?: Array<{ value: string; label: string }> } = {
			statuses: [],
			errors: [],
		};
		const host = mockHost(captures);
		handleUndo(host, mockKernel([userMsg("a"), reminderMsg("reminder"), userMsg("b")]), "");
		expect(captures.choices?.map((c) => c.label)).toEqual(["b", "a"]);
	});

	test("rollback never crosses the compaction boundary; reminders do not count as turns", () => {
		const captures = { statuses: [] as string[], errors: [] as string[] };
		const host = mockHost(captures);
		const kernel = mockKernel([userMsg("old"), summaryMsg(), userMsg("new"), reminderMsg("note")]);
		// the only rollback-able turn above the boundary is "new": asking for 2 hits the summary
		handleUndo(host, kernel, "2");
		expect(captures.errors.some((e) => e.includes("Cannot roll back past a compaction summary"))).toBe(true);

		const kernel2 = mockKernel([userMsg("old"), summaryMsg(), userMsg("new"), reminderMsg("note")]);
		handleUndo(host, kernel2, "1"); // the reminder must not have consumed the count
		expect(captures.statuses.some((s) => s.includes("Rolled back 1 turns"))).toBe(true);
		// cut lands right before "new": the reminder and "new" are gone, the summary boundary survives
		const remaining = kernel2.agent.state.messages as AgentMessage[];
		expect(remaining.length).toBe(2); // "old" + the compaction summary itself
	});
});

describe("system-reminder rendering in replay (B1)", () => {
	test("systemReminderHeadline: first non-empty line inside the tag; empty string without the tag", () => {
		expect(systemReminderHeadline("<system-reminder>\nfirst line\nsecond line\n</system-reminder>")).toBe("first line");
		expect(systemReminderHeadline("  <system-reminder>\n\n  spaced  \n</system-reminder>")).toBe("spaced");
		expect(systemReminderHeadline("plain user text")).toBe("");
	});

	test("replay: reminder renders as a compact status line, not a user bubble", () => {
		const styles = createTheme();
		const components = renderTranscript(
			[userMsg("real question"), reminderMsg("The user cancelled the current mobai."), userMsg("next question")],
			{
				styles,
				markdownTheme: {} as never,
				cwd: "/tmp",
				isExpanded: () => false,
				requestRender: () => {},
			},
		);
		const statusLines = components.filter((c) => c instanceof StatusMessage) as StatusMessage[];
		expect(statusLines.length).toBe(1);
		expect(JSON.stringify(statusLines[0])).toContain("The user cancelled the current mobai.");
	});
});
