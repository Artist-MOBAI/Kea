import type { AgentMessage, Entry } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import { foldProjection } from "../src/session-projection.ts";
import {
	createTodoListTool,
	createTodoReminderProvider,
	hydrateTodosFromMessages,
	renderTodoList,
	type TodoItem,
	type TodoStore,
	todoEntryProjection,
} from "../src/todo.ts";

function makeStore(): TodoStore & { items: TodoItem[] } {
	const state = { items: [] as TodoItem[] };
	return {
		get items() {
			return state.items;
		},
		get: () => state.items,
		set: (next) => {
			state.items = [...next];
		},
	};
}

const todos = (n: number, status: TodoItem["status"] = "pending"): TodoItem[] =>
	Array.from({ length: n }, (_, i) => ({ title: `task ${i + 1}`, status }));

describe("renderTodoList", () => {
	test("empty list and multi-status rendering", () => {
		expect(renderTodoList([])).toBe("Todo list is empty.");
		const text = renderTodoList([
			{ title: "a", status: "in_progress" },
			{ title: "b", status: "done" },
			{ title: "c", status: "pending" },
		]);
		expect(text).toBe("[in_progress] a\n[done] b\n[pending] c");
	});
});

describe("todo_list tool semantics (full-list replacement)", () => {
	test("omitting todos = query, no state change", async () => {
		const store = makeStore();
		store.set(todos(2));
		const tool = createTodoListTool(store);
		const result = await tool.execute("id", {});
		expect(result.content[0]?.text).toContain("[pending] task 1");
		expect(store.items.length).toBe(2);
	});

	test("passing a list = full replacement", async () => {
		const store = makeStore();
		store.set(todos(5));
		const tool = createTodoListTool(store);
		await tool.execute("id", { todos: todos(1, "in_progress") });
		expect(store.items).toEqual([{ title: "task 1", status: "in_progress" }]);
	});

	test("an empty array = clear", async () => {
		const store = makeStore();
		store.set(todos(3));
		const tool = createTodoListTool(store);
		const result = await tool.execute("id", { todos: [] });
		expect(store.items.length).toBe(0);
		expect(result.content[0]?.text).toBe("Todo list cleared.");
	});

	test("a write echoes the list and the discipline reminder", async () => {
		const store = makeStore();
		const tool = createTodoListTool(store);
		const result = await tool.execute("id", { todos: todos(1) });
		expect(result.content[0]?.text).toContain("Todo list updated.");
		expect(result.content[0]?.text).toContain("in_progress");
		expect(result.details).toEqual({ todos: todos(1) });
	});
});

describe("hydrateTodosFromMessages (resume restoration)", () => {
	const todoCall = (args: unknown): AgentMessage =>
		({
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "todo_list", arguments: args }],
			timestamp: 1,
		}) as unknown as AgentMessage;

	test("takes the last written todos", () => {
		const messages = [
			todoCall({ todos: [{ title: "old", status: "pending" }] }),
			todoCall({ todos: [{ title: "new", status: "done" }] }),
		];
		expect(hydrateTodosFromMessages(messages)).toEqual([{ title: "new", status: "done" }]);
	});

	test("query calls do not change the restoration result (keeps scanning backwards for writes)", () => {
		const messages = [todoCall({ todos: [{ title: "kept", status: "pending" }] }), todoCall({})];
		expect(hydrateTodosFromMessages(messages)).toEqual([{ title: "kept", status: "pending" }]);
	});

	test("an empty-array write restores as an empty list", () => {
		const messages = [todoCall({ todos: [{ title: "x", status: "pending" }] }), todoCall({ todos: [] })];
		expect(hydrateTodosFromMessages(messages)).toEqual([]);
	});

	test("no history returns undefined", () => {
		expect(hydrateTodosFromMessages([])).toBeUndefined();
	});

	test("filters invalid entries and falls back to pending", () => {
		const messages = [todoCall({ todos: [{ title: "", status: "pending" }, { title: "ok" }, { status: "done" }] })];
		expect(hydrateTodosFromMessages(messages)).toEqual([{ title: "ok", status: "pending" }]);
	});
});

describe("todo staleness reminder provider", () => {
	const assistantMsg = (): AgentMessage =>
		({ role: "assistant", content: [], timestamp: 1 }) as unknown as AgentMessage;
	const todoWrite = (): AgentMessage =>
		({
			role: "assistant",
			content: [
				{ type: "toolCall", id: "c1", name: "todo_list", arguments: { todos: [{ title: "t", status: "pending" }] } },
			],
			timestamp: 1,
		}) as unknown as AgentMessage;

	test("no reminder below the threshold (<10 turns after the write)", () => {
		const store = makeStore();
		store.set(todos(1));
		const provider = createTodoReminderProvider(store);
		const messages = [todoWrite(), ...Array.from({ length: 9 }, assistantMsg)];
		expect(provider.evaluate({ isNewTurn: false, messages })).toBeUndefined();
	});

	test("at the threshold the reminder includes gentle wording and the current list", () => {
		const store = makeStore();
		store.set(todos(1));
		const provider = createTodoReminderProvider(store);
		const messages = [todoWrite(), ...Array.from({ length: 10 }, assistantMsg)];
		const text = provider.evaluate({ isNewTurn: false, messages });
		expect(text).toContain("not been updated recently");
		expect(text).toContain("NEVER mention this reminder to the user");
		expect(text).toContain("[pending] task 1");
	});

	test("throttled after reminding: the turns right after do not repeat", () => {
		const store = makeStore();
		store.set(todos(1));
		const provider = createTodoReminderProvider(store);
		const base = [todoWrite(), ...Array.from({ length: 10 }, assistantMsg)];
		const first = provider.evaluate({ isNewTurn: false, messages: base });
		expect(first).toBeDefined();
		// Simulate the reminder already injected into context (a user message); subsequent turns below the throttle threshold do not remind again
		const reminderMsg = {
			role: "user",
			content: [{ type: "text", text: first as string }],
			timestamp: 1,
		} as unknown as AgentMessage;
		expect(provider.evaluate({ isNewTurn: false, messages: [...base, reminderMsg, assistantMsg()] })).toBeUndefined();
	});

	test("an empty list never reminds", () => {
		const store = makeStore();
		const provider = createTodoReminderProvider(store);
		const messages = [...Array.from({ length: 20 }, assistantMsg)];
		expect(provider.evaluate({ isNewTurn: false, messages })).toBeUndefined();
	});

	test("replays the current list after compaction (one-shot)", () => {
		const store = makeStore();
		store.set(todos(1));
		const provider = createTodoReminderProvider(store);
		provider.onCompacted?.();
		const text = provider.evaluate({ isNewTurn: false, messages: [] });
		expect(text).toContain("after context compaction");
		expect(text).toContain("[pending] task 1");
		// One-shot: the next collect does not replay
		expect(provider.evaluate({ isNewTurn: false, messages: [] })).toBeUndefined();
	});
});

describe("todoEntryProjection (folds the raw Entry stream, survives compaction)", () => {
	const messageEntry = (message: AgentMessage): Entry =>
		({ type: "message", id: "m", seq: 0, parentId: null, timestamp: 1, message }) as unknown as Entry;
	const compactionEntry = (): Entry =>
		({
			type: "compaction",
			id: "c",
			seq: 1,
			parentId: null,
			timestamp: 2,
			summary: "s",
			retainedTail: [],
			tokensBefore: 10,
		}) as unknown as Entry;
	const todoCall = (args: unknown): AgentMessage =>
		({
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "todo_list", arguments: args }],
			timestamp: 1,
		}) as unknown as AgentMessage;

	test("a todo write before compaction is still restorable (not swallowed by the summary)", () => {
		const entries = [messageEntry(todoCall({ todos: [{ title: "kept", status: "pending" }] })), compactionEntry()];
		expect(foldProjection(todoEntryProjection, entries)).toEqual([{ title: "kept", status: "pending" }]);
	});

	test("a new write after compaction takes precedence", () => {
		const entries = [
			messageEntry(todoCall({ todos: [{ title: "old", status: "pending" }] })),
			compactionEntry(),
			messageEntry(todoCall({ todos: [{ title: "new", status: "done" }] })),
		];
		expect(foldProjection(todoEntryProjection, entries)).toEqual([{ title: "new", status: "done" }]);
	});

	test("no writes returns undefined", () => {
		expect(foldProjection(todoEntryProjection, [compactionEntry()])).toBeUndefined();
	});
});
