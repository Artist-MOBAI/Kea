import { visibleWidth } from "@earendil-works/pi-tui";
import type { TodoItem } from "@kea/core";
import { describe, expect, test } from "vitest";
import {
	formatHiddenCounts,
	selectVisibleTodos,
	TODO_MAX_VISIBLE,
	TodoPanel,
} from "../src/tui/components/chrome/todo-panel.ts";
import { identityStyles } from "./helpers/styles.ts";

const styles = identityStyles();

const item = (title: string, status: TodoItem["status"]): TodoItem => ({ title, status });
const mixed = (): TodoItem[] => [
	item("a", "done"),
	item("b", "in_progress"),
	item("c", "pending"),
	item("d", "pending"),
	item("e", "done"),
	item("f", "pending"),
	item("g", "in_progress"),
];

describe("selectVisibleTodos (folding algorithm)", () => {
	test("all visible under MAX_VISIBLE", () => {
		const todos = [item("a", "pending"), item("b", "done")];
		const { visible, hiddenCounts } = selectVisibleTodos(todos);
		expect(visible).toEqual(todos);
		expect(hiddenCounts).toEqual({ done: 0, inProgress: 0, pending: 0 });
	});

	test("on overflow keeps all in_progress + the latest done + the earliest pending", () => {
		const { visible, hiddenCounts } = selectVisibleTodos(mixed());
		expect(visible.length).toBe(TODO_MAX_VISIBLE);
		expect(visible.filter((t) => t.status === "in_progress").length).toBe(2);
		const dones = visible.filter((t) => t.status === "done");
		expect(dones.map((t) => t.title)).toEqual(["e"]);
		expect(visible.filter((t) => t.status === "pending").map((t) => t.title)).toEqual(["c", "d"]);
		expect(hiddenCounts).toEqual({ done: 1, inProgress: 0, pending: 1 });
	});

	test("preserves the original order in the output", () => {
		const { visible } = selectVisibleTodos(mixed());
		const order = visible.map((t) => t.title);
		expect(order).toEqual([...order].sort((x, y) => "abcdefg".indexOf(x) - "abcdefg".indexOf(y)));
	});

	test("formatHiddenCounts orders done/in progress/pending", () => {
		expect(formatHiddenCounts({ done: 2, inProgress: 1, pending: 3 })).toBe("2 done · 1 in progress · 3 pending");
		expect(formatHiddenCounts({ done: 0, inProgress: 0, pending: 2 })).toBe("2 pending");
	});
});

describe("TodoPanel rendering", () => {
	test("empty list renders empty (the slot disappears)", () => {
		const panel = new TodoPanel(styles);
		expect(panel.render(80)).toEqual([]);
	});

	test("item rows and the title bar", () => {
		const panel = new TodoPanel(styles);
		panel.setTodos([item("write tests", "in_progress"), item("old", "done")]);
		const lines = panel.render(80);
		expect(lines.some((l) => l.includes("Todo"))).toBe(true);
		expect(lines.some((l) => l.includes("write tests"))).toBe(true);
		expect(lines.some((l) => l.includes("old"))).toBe(true);
	});

	test("overflow shows +N more with a Ctrl+T hint; expanded shows all with a collapse hint", () => {
		const panel = new TodoPanel(styles);
		panel.setTodos(mixed());
		expect(panel.hasOverflow()).toBe(true);
		const collapsed = panel.render(80);
		expect(collapsed.some((l) => l.includes("more (") && l.includes("Ctrl+T to expand"))).toBe(true);
		const visibleRows = collapsed.filter((l) => [" a", " b", " c", " d", " e", " f", " g"].some((t) => l.endsWith(t)));
		expect(visibleRows.length).toBe(TODO_MAX_VISIBLE);

		panel.toggleExpanded();
		const expanded = panel.render(80);
		expect(expanded.some((l) => l.includes("all 7 items") && l.includes("Ctrl+T to collapse"))).toBe(true);
	});

	test("toggleExpanded is a no-op without overflow", () => {
		const panel = new TodoPanel(styles);
		panel.setTodos([item("a", "pending")]);
		panel.toggleExpanded();
		expect(panel.render(80).some((l) => l.includes("Ctrl+T"))).toBe(false);
	});

	test("clear resets items and the expanded state", () => {
		const panel = new TodoPanel(styles);
		panel.setTodos(mixed());
		panel.toggleExpanded();
		panel.clear();
		expect(panel.render(80)).toEqual([]);
		expect(panel.hasOverflow()).toBe(false);
	});

	test("after expanding, a list shrunk below the overflow line drops the dead Ctrl+T collapse hint (staleness)", () => {
		const panel = new TodoPanel(styles);
		panel.setTodos(mixed());
		panel.toggleExpanded();
		expect(panel.render(80).some((l) => l.includes("Ctrl+T to collapse"))).toBe(true);
		panel.setTodos([item("a", "pending"), item("b", "done"), item("c", "pending")]);
		const lines = panel.render(80);
		expect(lines.some((l) => l.includes("Ctrl+T"))).toBe(false);
		expect(lines.some((l) => l.includes("a"))).toBe(true);
		expect(lines.some((l) => l.includes("b"))).toBe(true);
		expect(lines.some((l) => l.includes("c"))).toBe(true);
		panel.setTodos(mixed());
		expect(panel.render(80).some((l) => l.includes("Ctrl+T to expand"))).toBe(true);
	});

	test("width safety: every rendered line ≤ width", () => {
		const panel = new TodoPanel(styles);
		panel.setTodos(
			Array.from({ length: 12 }, (_, i) => item(`a very long task title that might overflow ${i}`, "pending")),
		);
		for (const width of [40, 60, 80]) {
			for (const line of panel.render(width)) {
				expect(visibleWidth(line), `width=${width}`).toBeLessThanOrEqual(width);
			}
		}
		panel.toggleExpanded();
		for (const width of [40, 60, 80]) {
			for (const line of panel.render(width)) {
				expect(visibleWidth(line), `expanded width=${width}`).toBeLessThanOrEqual(width);
			}
		}
	});

	test("narrow-terminal width safety (width 6/8: panel mounts directly on the tui, no WidthSafe fallback)", () => {
		const panel = new TodoPanel(styles);
		panel.setTodos(
			Array.from({ length: 9 }, (_, i) => item(`a very long task title that might overflow ${i}`, "in_progress")),
		);
		for (const width of [6, 8]) {
			for (const line of panel.render(width)) {
				expect(visibleWidth(line), `collapsed width=${width}`).toBeLessThanOrEqual(width);
			}
			panel.toggleExpanded();
			for (const line of panel.render(width)) {
				expect(visibleWidth(line), `expanded width=${width}`).toBeLessThanOrEqual(width);
			}
			panel.toggleExpanded();
		}
	});
});
