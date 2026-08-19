import { describe, expect, test } from "vitest";
import { type InjectionProvider, InjectionScheduler, wrapSystemReminder } from "../src/injection/scheduler.ts";
import { isSystemReminderText } from "../src/text.ts";

const input = { isNewTurn: false, messages: [] } as const;

function provider(variant: string, text: string | undefined, onCompacted?: () => void): InjectionProvider {
	return { variant, evaluate: () => text, ...(onCompacted ? { onCompacted } : {}) };
}

describe("wrapSystemReminder", () => {
	test("wraps into the system-reminder channel tag", () => {
		expect(wrapSystemReminder("hello")).toBe("<system-reminder>\nhello\n</system-reminder>");
	});
});

describe("InjectionScheduler", () => {
	test("collects non-empty injections in registration order and wraps them", () => {
		const scheduler = new InjectionScheduler();
		scheduler.register(provider("a", "first"));
		scheduler.register(provider("b", undefined));
		scheduler.register(provider("c", "third"));
		expect(scheduler.collect(input)).toEqual([
			"<system-reminder>\nfirst\n</system-reminder>",
			"<system-reminder>\nthird\n</system-reminder>",
		]);
	});

	test("empty string counts as no injection", () => {
		const scheduler = new InjectionScheduler();
		scheduler.register(provider("empty", ""));
		expect(scheduler.collect(input)).toEqual([]);
	});

	test("noteCompacted notifies every provider implementing onCompacted", () => {
		const scheduler = new InjectionScheduler();
		let compacted = 0;
		scheduler.register(provider("a", "x", () => compacted++));
		scheduler.register(provider("b", "y"));
		scheduler.noteCompacted();
		expect(compacted).toBe(1);
	});

	test("provider manages its own throttle state (simulating a todo reminder counter)", () => {
		const scheduler = new InjectionScheduler();
		let turns = 0;
		scheduler.register({
			variant: "counted",
			evaluate: () => {
				turns += 1;
				return turns >= 3 ? `reminder at turn ${turns}` : undefined;
			},
		});
		expect(scheduler.collect(input)).toEqual([]);
		expect(scheduler.collect(input)).toEqual([]);
		expect(scheduler.collect(input)).toEqual(["<system-reminder>\nreminder at turn 3\n</system-reminder>"]);
	});

	test("size reflects the registration count", () => {
		const scheduler = new InjectionScheduler();
		expect(scheduler.size).toBe(0);
		scheduler.register(provider("a", "x"));
		expect(scheduler.size).toBe(1);
	});
});

describe("isSystemReminderText (marker predicate and wrap round-trip)", () => {
	test("output of wrapSystemReminder is recognized by the predicate", () => {
		expect(isSystemReminderText(wrapSystemReminder("state"))).toBe(true);
	});
	test("plain text and injection-target text are not recognized", () => {
		expect(isSystemReminderText("hello")).toBe(false);
		expect(isSystemReminderText("<untrusted_objective>x</untrusted_objective>")).toBe(false);
	});
	test("leading whitespace tolerated", () => {
		expect(isSystemReminderText("  <system-reminder>late")).toBe(true);
	});
});
