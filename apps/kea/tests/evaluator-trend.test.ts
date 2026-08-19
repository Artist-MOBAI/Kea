import { describe, expect, test } from "vitest";
import { sparkline } from "../src/tui/commands/evaluator-trend.ts";

describe("sparkline (metric trend visualization)", () => {
	test("empty sequence returns an empty string; a single value maps to the mid block", () => {
		expect(sparkline([])).toBe("");
		expect(sparkline([3.14])).toBe("▅");
	});

	test("ascending sequence maps to ▁→█", () => {
		expect(sparkline([1, 2, 3, 4, 5])).toBe("▁▃▅▆█");
	});

	test("constant sequence maps to the median block", () => {
		expect(sparkline([7, 7, 7])).toBe("▅▅▅");
	});

	test("minimize convergence curve (high→low)", () => {
		const line = sparkline([421, 300, 200, 102]);
		expect(line.startsWith("█")).toBe(true);
		expect(line.endsWith("▁")).toBe(true);
	});
});
