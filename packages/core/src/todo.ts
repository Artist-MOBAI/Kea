import type { AgentMessage, Entry } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { InjectionInput, InjectionProvider } from "./injection/scheduler.ts";
import { foldProjection, type Projection } from "./session-projection.ts";

// TodoList: multi-step task tracking. Semantics: whole-list replacement — omit todos to query, empty array to
// clear, pass a list to replace entirely.

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
	title: string;
	status: TodoStatus;
}

export interface TodoStore {
	get(): readonly TodoItem[];
	set(items: readonly TodoItem[]): void;
}

export function renderTodoList(todos: readonly TodoItem[]): string {
	if (todos.length === 0) return "Todo list is empty.";
	return todos.map((t) => `[${t.status}] ${t.title}`).join("\n");
}

const TODO_WRITE_REMINDER =
	"Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.";

export const TODO_LIST_TOOL_NAME = "todo_list";

/** JSON Schema payload z.toJSONSchema emits for one schema (single-schema overload — ReturnType alone would pick the registry overload). */
type JsonSchemaOf<T extends z.ZodType> = ReturnType<typeof z.toJSONSchema<T>>;

export interface TodoListTool {
	name: string;
	label: string;
	description: string;
	parameters: JsonSchemaOf<ReturnType<typeof todoParameters>>;
	executionMode: "sequential";
	execute(
		id: string,
		params: z.input<ReturnType<typeof todoParameters>>,
	): Promise<{
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
	}>;
}

function todoParameters() {
	return z.strictObject({
		todos: z
			.array(
				z.strictObject({
					title: z.string().meta({ description: "Short, actionable title for the todo." }),
					status: z.enum(["pending", "in_progress", "done"]).meta({ description: "Current status of the todo." }),
				}),
			)
			.optional()
			.meta({ description: "The updated todo list. Omit to read the current list. Pass an empty array to clear." }),
	});
}

const TODO_LIST_DESCRIPTION = [
	"Track multi-step work with a structured todo list (pending / in_progress / done).",
	"Semantics: passing todos REPLACES the whole list; omit todos to read the current list; pass an empty array to clear.",
	"Use for long investigations, sequences of edits, and multi-stage pipelines — not single-step tasks.",
	"Keep exactly one task in_progress while work is underway. Mark a task done ONLY when it is fully accomplished — not while tests are red or the implementation is partial.",
	"Do NOT re-call this tool when nothing meaningful has changed since the last call.",
].join("\n");

export function createTodoListTool(store: TodoStore): TodoListTool {
	const parameters = todoParameters();
	return {
		name: TODO_LIST_TOOL_NAME,
		label: "Todo list",
		description: TODO_LIST_DESCRIPTION,
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id, params) {
			if (params.todos === undefined) {
				return { content: [{ type: "text", text: renderTodoList(store.get()) }], details: {} };
			}
			store.set(params.todos);
			if (params.todos.length === 0) {
				return { content: [{ type: "text", text: "Todo list cleared." }], details: {} };
			}
			const text = `Todo list updated.\n${renderTodoList(params.todos)}\n\n${TODO_WRITE_REMINDER}`;
			return { content: [{ type: "text", text }], details: { todos: params.todos } };
		},
	};
}

const REMINDER_TURNS_SINCE_WRITE = 10;
const REMINDER_TURNS_BETWEEN_REMINDERS = 10;

const REMINDER_MARKER = "The TodoList tool has not been updated recently.";

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return typeof m === "object" && m !== null && "role" in m && m.role === "assistant";
}

/** Whether a message is a todo_list write call (args.todos is an array; a query is not). */
function isTodoWriteCall(m: AgentMessage): boolean {
	if (!isAssistantMessage(m)) return false;
	return m.content.some((block) => {
		if (block.type !== "toolCall" || block.name !== TODO_LIST_TOOL_NAME) return false;
		return Array.isArray(block.arguments.todos);
	});
}

function isReminderMessage(m: AgentMessage): boolean {
	if (typeof m !== "object" || m === null || !("role" in m) || m.role !== "user") return false;
	// user message content may be a bare string (pi UserMessage contract); only the array shape can contain the reminder text block
	const content = m.content;
	if (!Array.isArray(content)) return false;
	return content.some((block) => block.type === "text" && block.text.includes(REMINDER_MARKER));
}

// Stale-todo reminder: inject when ≥10 assistant turns passed since the last write and ≥10 since the last
// reminder; replay the current list once after compaction.
export function createTodoReminderProvider(store: TodoStore): InjectionProvider {
	let reannounce = false;
	return {
		variant: "todo_list_reminder",
		evaluate(input: InjectionInput): string | undefined {
			if (reannounce) {
				reannounce = false;
				const todos = store.get();
				if (todos.length > 0) {
					return `The todo list still tracks open work after context compaction:\n${renderTodoList(todos)}`;
				}
			}
			const todos = store.get();
			if (todos.length === 0) return undefined;

			let turnsSinceWrite = 0;
			let turnsSinceReminder = 0;
			let sawWrite = false;
			let sawReminder = false;
			for (let i = input.messages.length - 1; i >= 0; i--) {
				const m = input.messages[i];
				if (!m) continue;
				if (isTodoWriteCall(m)) {
					sawWrite = true;
					break;
				}
				if (isReminderMessage(m)) sawReminder = true;
				if (isAssistantMessage(m)) {
					turnsSinceWrite += 1;
					if (!sawReminder) turnsSinceReminder += 1;
				}
			}
			// list exists but no write point found in history (resume/after compaction): treat the write point as missing and go through reminder throttling
			if (!sawWrite) turnsSinceWrite = Math.max(turnsSinceWrite, REMINDER_TURNS_SINCE_WRITE);
			if (turnsSinceWrite < REMINDER_TURNS_SINCE_WRITE) return undefined;
			if (turnsSinceReminder < REMINDER_TURNS_BETWEEN_REMINDERS) return undefined;
			return [
				REMINDER_MARKER,
				"If you are working on tasks that would benefit from progress tracking, consider using the todo list",
				"to update task status. Also consider clearing or rewriting it if it has become stale.",
				"Only use it if relevant. This is a gentle reminder; ignore it if not applicable.",
				"Make sure that you NEVER mention this reminder to the user.",
				"",
				`Current list:\n${renderTodoList(todos)}`,
			].join("\n");
		},
		onCompacted() {
			reannounce = true;
		},
	};
}

/** Extract the todo list a single message writes (undefined for anything that is not a todo_list write). */
export function extractTodoWrite(message: AgentMessage): TodoItem[] | undefined {
	if (!isAssistantMessage(message)) return undefined;
	for (const block of message.content) {
		if (block.type !== "toolCall" || block.name !== TODO_LIST_TOOL_NAME) continue;
		const todos = block.arguments.todos;
		if (Array.isArray(todos)) {
			return (todos as Array<{ title?: unknown; status?: unknown }>)
				.filter((t) => typeof t.title === "string" && t.title.length > 0)
				.map((t) => ({ title: t.title as string, status: (t.status as TodoStatus) ?? "pending" }));
		}
	}
	return undefined;
}

/** Todo list as a pure fold over the message stream: the last whole-list write wins. */
export const todoProjection: Projection<TodoItem[] | undefined, AgentMessage, TodoItem[] | undefined> = {
	name: "todos",
	init: () => undefined,
	apply(event, state) {
		return extractTodoWrite(event) ?? state;
	},
	view: (state) => state,
};

// Todo list as a fold over the raw durable entry stream (not the compaction-pruned replayed messages):
// the list stays recoverable after a compaction summarizes away the original todo_list tool calls.
export const todoEntryProjection: Projection<TodoItem[] | undefined, Entry, TodoItem[] | undefined> = {
	name: "todos",
	init: () => undefined,
	apply(entry, state) {
		if (entry.type !== "message") return state;
		return extractTodoWrite(entry.message) ?? state;
	},
	view: (state) => state,
};

/** Recover the most recent todo list from message history (for resume/replay): fold the stream to the last write. */
export function hydrateTodosFromMessages(messages: readonly AgentMessage[]): TodoItem[] | undefined {
	return foldProjection(todoProjection, messages);
}
