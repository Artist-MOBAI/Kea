import { describe, expect, test } from "vitest";
import { createStagnationGuard, stagnationMessage } from "../src/loop/stagnation.ts";
import { wrapSystemReminder } from "../src/text.ts";

describe("stagnation guard (M1)", () => {
	test("three identical calls trigger repeated_call", () => {
		const guard = createStagnationGuard();
		expect(guard.record("bash", "{}", false)).toBeUndefined();
		expect(guard.record("bash", "{}", false)).toBeUndefined();
		const reason = guard.record("bash", "{}", false);
		expect(reason?.kind).toBe("repeated_call");
		expect(stagnationMessage(reason as never)).toContain("loop guard");
	});

	test("three consecutive failures trigger failure_streak; success resets", () => {
		const guard = createStagnationGuard();
		expect(guard.record("grep", "a", true)).toBeUndefined();
		expect(guard.record("glob", "b", true)).toBeUndefined();
		guard.record("read", "c", false);
		expect(guard.record("grep", "d", true)).toBeUndefined();
		expect(guard.record("grep", "e", true)).toBeUndefined();
		expect(guard.record("grep", "f", true)?.kind).toBe("failure_streak");
	});

	test("reset clears state", () => {
		const guard = createStagnationGuard();
		guard.record("bash", "{}", false);
		guard.record("bash", "{}", false);
		guard.reset();
		expect(guard.record("bash", "{}", false)).toBeUndefined();
	});

	test("polling tools (job_status) are exempt: identical repeated calls never trigger", () => {
		const guard = createStagnationGuard();
		for (let i = 0; i < 5; i++) {
			expect(guard.record("job_status", '{"job_id":"j1"}', false)).toBeUndefined();
		}
	});

	test("exempt polling does not contribute to failure streaks nor break other tools' counts", () => {
		const guard = createStagnationGuard();
		// Polling failures do not count toward the failure streak
		expect(guard.record("job_status", "{}", true)).toBeUndefined();
		expect(guard.record("job_status", "{}", true)).toBeUndefined();
		expect(guard.record("job_status", "{}", true)).toBeUndefined();
		// Interleaved polling does not reset ordinary tools' repeat counts: three identical bash calls still trigger
		expect(guard.record("bash", "{}", false)).toBeUndefined();
		guard.record("job_status", "{}", false);
		expect(guard.record("bash", "{}", false)).toBeUndefined();
		guard.record("job_status", "{}", false);
		expect(guard.record("bash", "{}", false)?.kind).toBe("repeated_call");
	});

	test("two-level reminders: threshold emits the plain level-1 text; 2×threshold escalates to fielded + hard prohibition", () => {
		const guard = createStagnationGuard();
		for (let i = 0; i < 2; i++) guard.record("bash", "{}", false);
		const first = guard.record("bash", "{}", false);
		expect(first?.kind).toBe("repeated_call");
		expect(first?.escalated).toBeUndefined();
		expect(stagnationMessage(first as never)).not.toContain("prior_warning");
		for (let i = 0; i < 2; i++) guard.record("bash", "{}", false);
		const second = guard.record("bash", "{}", false);
		expect(second?.kind).toBe("repeated_call");
		expect(second?.escalated).toBe(true);
		const text = stagnationMessage(second as never);
		expect(text).toContain("prior_warning: ignored");
		expect(text).toContain('tool: "bash"');
		expect(text).toContain("MUST NOT");
	});

	test("wrapper goes through text.ts single-source wrapSystemReminder (byte-equality anchor)", () => {
		const reason = { kind: "failure_streak", toolName: "bash", count: 3 } as const;
		const text = stagnationMessage(reason);
		expect(text.startsWith("<system-reminder>\n")).toBe(true);
		expect(text.endsWith("\n</system-reminder>")).toBe(true);
		const body = text.slice("<system-reminder>\n".length, -("</system-reminder>".length + 1));
		expect(text).toBe(wrapSystemReminder(body));
	});
});
