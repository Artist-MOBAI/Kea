import { describe, expect, test } from "vitest";
import { foldProjection, type Projection } from "../src/session-projection.ts";

const sumProjection: Projection<number, number, number> = {
	name: "sum",
	init: () => 0,
	apply(event, state) {
		return state + event;
	},
	view: (state) => state,
};

const lastNonEmptyProjection: Projection<string[], string, string[]> = {
	name: "last",
	init: () => [],
	apply(event, state) {
		return event === "" ? state : [event];
	},
	view: (state) => state,
};

describe("foldProjection", () => {
	test("empty stream returns the init view", () => {
		expect(foldProjection(sumProjection, [])).toBe(0);
		expect(foldProjection(lastNonEmptyProjection, [])).toEqual([]);
	});

	test("folds the whole stream in order", () => {
		expect(foldProjection(sumProjection, [1, 2, 3])).toBe(6);
	});

	test("no shared mutable state between folds", () => {
		const a = foldProjection(sumProjection, [1, 2]);
		const b = foldProjection(sumProjection, [10]);
		expect(a).toBe(3);
		expect(b).toBe(10);
	});

	test("non-write events keep state (last-write-wins)", () => {
		expect(foldProjection(lastNonEmptyProjection, ["a", "", "b"])).toEqual(["b"]);
	});
});
