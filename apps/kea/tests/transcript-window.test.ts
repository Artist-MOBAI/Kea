import { describe, expect, test } from "vitest";
import { RoundSection } from "../src/tui/components/messages/round-section.ts";
import { SectionCard } from "../src/tui/components/messages/section-card.ts";
import {
	KEEP_RECENT_STEPS,
	TRANSCRIPT_HYSTERESIS,
	TRANSCRIPT_MAX_TURNS,
	turnsToTrim,
} from "../src/tui/controllers/transcript-window.ts";
import { identityStyles } from "./helpers/styles.ts";

const styles = identityStyles();

describe("turnsToTrim (turn-level window algorithm)", () => {
	test("no trim until max+hysteresis is exceeded", () => {
		expect(turnsToTrim(TRANSCRIPT_MAX_TURNS)).toBe(0);
		expect(turnsToTrim(TRANSCRIPT_MAX_TURNS + TRANSCRIPT_HYSTERESIS)).toBe(0);
	});

	test("past the threshold, trims back to max", () => {
		expect(turnsToTrim(TRANSCRIPT_MAX_TURNS + TRANSCRIPT_HYSTERESIS + 1)).toBe(TRANSCRIPT_HYSTERESIS + 1);
		expect(turnsToTrim(TRANSCRIPT_MAX_TURNS + TRANSCRIPT_HYSTERESIS + 1)).toBe(
			TRANSCRIPT_MAX_TURNS + TRANSCRIPT_HYSTERESIS + 1 - TRANSCRIPT_MAX_TURNS,
		);
	});

	test("the latest round is never trimmed (no trim when only 1 round remains)", () => {
		expect(turnsToTrim(1, 0, 0)).toBe(0);
	});

	test("custom parameters", () => {
		expect(turnsToTrim(10, 3, 2)).toBe(7);
		expect(turnsToTrim(5, 3, 2)).toBe(0);
	});
});

describe("SectionCard in-round folding", () => {
	const fakeChild = () => ({ render: () => ["x"], invalidate: () => {} });

	test("no folding under the cap", () => {
		const card = new SectionCard(styles);
		card.addChild(fakeChild());
		card.addChild(fakeChild());
		expect(card.foldOldChildren(3)).toBe(0);
		expect(card.childCount).toBe(2);
	});

	test("folding keeps the first child + the most recent N, renders the count line", () => {
		const card = new SectionCard(styles);
		for (let i = 0; i < 6; i++) card.addChild(fakeChild());
		const removed = card.foldOldChildren(2);
		expect(removed).toBe(3);
		expect(card.childCount).toBe(3);
		const lines = card.render(80);
		expect(lines.some((l) => l.includes("3 earlier steps folded"))).toBe(true);
	});

	test("folded counts accumulate", () => {
		const card = new SectionCard(styles);
		for (let i = 0; i < 5; i++) card.addChild(fakeChild());
		expect(card.foldOldChildren(3)).toBe(1);
		card.addChild(fakeChild());
		card.addChild(fakeChild());
		expect(card.foldOldChildren(3)).toBe(2);
		const lines = card.render(80);
		expect(lines.some((l) => l.includes("3 earlier steps folded"))).toBe(true);
	});

	test("empty-render first child (e.g. ThinkingView, no thinking) must not swallow the fold line (regression)", () => {
		const emptyChild = { render: () => [] as string[], invalidate: () => {} };
		const card = new SectionCard(styles);
		card.addChild(emptyChild);
		for (let i = 0; i < 6; i++) card.addChild(fakeChild());
		expect(card.foldOldChildren(2)).toBe(4);
		const lines = card.render(80);
		expect(lines.some((l) => l.includes("4 earlier steps folded"))).toBe(true);
	});

	test("still emits the fold line when all children render empty and folds exist", () => {
		const emptyChild = { render: () => [] as string[], invalidate: () => {} };
		const card = new SectionCard(styles);
		card.addChild(emptyChild);
		for (let i = 0; i < 4; i++) card.addChild(fakeChild());
		expect(card.foldOldChildren(0)).toBe(4);
		const lines = card.render(80);
		expect(lines.some((l) => l.includes("4 earlier steps folded"))).toBe(true);
	});
});

describe("RoundSection foldOldSteps", () => {
	test("delegates folding to the card", () => {
		const section = new RoundSection(styles);
		section.appendUser({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } as never);
		for (let i = 0; i < KEEP_RECENT_STEPS + 5; i++) {
			section.addAgentChild({ render: () => ["step"], invalidate: () => {} });
		}
		const removed = section.foldOldSteps(KEEP_RECENT_STEPS);
		expect(removed).toBe(5);
		expect(section.card.childCount).toBe(KEEP_RECENT_STEPS + 1);
	});
});
