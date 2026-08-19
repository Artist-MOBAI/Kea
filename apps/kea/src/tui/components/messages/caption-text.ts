import { formatElapsed } from "../../constants/format.ts";
import type { SectionToolPart } from "./section-card.ts";
import { extractKeyArgument as extractToolKeyArg, type KeyArgOptions } from "./tool-call.ts";

// keyArg extraction reuses tool-call.ts's extractKeyArgument; empty normalizes to undefined
// (renders without parentheses).
function keyArg(name: string, args: unknown, cwd: string | undefined, options: KeyArgOptions): string | undefined {
	const text = extractToolKeyArg(name, args, cwd ?? "", options);
	return text === "" ? undefined : text;
}

const PLAIN_KEY_ARG: KeyArgOptions = { firstLine: true, flatten: false, relativize: false };

// The caption-sentence form differs per-branch from the tool-card header form, so default options
// can't be applied directly: path tools keep the path tail (truncate:"tail", flatten:false); others
// take the first line without flattening or cwd relativization, with tighter caps.
function extractKeyArgument(name: string, args: unknown, cwd?: string): string | undefined {
	switch (name) {
		case "read":
		case "write":
		case "edit":
		case "read_media_file":
			return keyArg(name, args, cwd, { keys: ["path"], flatten: false, truncate: "tail" });
		case "grep":
		case "glob":
			return keyArg(name, args, cwd, { ...PLAIN_KEY_ARG, keys: ["pattern"], maxLength: 30 });
		case "fetch_url":
			return keyArg(name, args, cwd, { ...PLAIN_KEY_ARG, keys: ["url"] });
		case "web_search":
			return keyArg(name, args, cwd, { ...PLAIN_KEY_ARG, keys: ["query"], maxLength: 40 });
		case "spawn_agent":
			// spawn_agent's description arg is named task here.
			return keyArg(name, args, cwd, { ...PLAIN_KEY_ARG, keys: ["description", "task"] });
		default:
			return keyArg(name, args, cwd, { ...PLAIN_KEY_ARG, anyValue: true });
	}
}

// First sentence as the live caption (the regex recognizes Chinese and English punctuation).
export function firstSentence(text: string, max = 60): string {
	const flat = text.split("\n")[0] ?? "";
	const m = /^[^.!?;。；;！!？?]+[.!?;。；;！!？?]?/.exec(flat);
	const sentence = (m?.[0] ?? flat).trim();
	return sentence.length > max ? `${sentence.slice(0, max)}…` : sentence;
}

export function describeTool(name: string, args: unknown, cwd?: string): string {
	if (name === "bash") return "Running a command";
	const arg = extractKeyArgument(name, args, cwd);
	return arg === undefined ? `Using ${name}` : `Using ${name} (${arg})`;
}

export function describeToolDone(
	name: string,
	args: unknown,
	durationMs: number,
	preview: string,
	isError: boolean,
	cwd: string,
): string {
	const arg = name === "bash" ? undefined : extractKeyArgument(name, args, cwd);
	const text = name === "bash" ? "Ran a command" : arg === undefined ? `Used ${name}` : `Used ${name} (${arg})`;
	const lineCount = preview === "" ? 0 : preview.replace(/\n$/, "").split("\n").length;
	const tail = isError ? " · failed" : lineCount > 0 ? ` · ${lineCount} ${lineCount === 1 ? "line" : "lines"}` : "";
	return `${text} · ${formatElapsed(durationMs)}${tail}`;
}

const METRIC_LINE = /^\s*METRIC\s+([A-Za-z0-9_.-]+=[^\s]+)/;

interface Counts {
	reads: number;
	writes: number;
	edits: number;
	commands: number;
	searches: number;
	others: number;
}

// Turn-end mechanical sentence: fallback until the AI summary arrives; kept if AI fails.
export function mechanicalSummary(parts: readonly SectionToolPart[], elapsedMs: number): string {
	const counts: Counts = { reads: 0, writes: 0, edits: 0, commands: 0, searches: 0, others: 0 };
	let metric: string | undefined;
	for (const part of parts) {
		switch (part.toolName) {
			case "read":
				counts.reads += 1;
				break;
			case "write":
				counts.writes += 1;
				break;
			case "edit":
				counts.edits += 1;
				break;
			case "bash":
				counts.commands += 1;
				break;
			case "grep":
			case "glob":
				counts.searches += 1;
				break;
			default:
				counts.others += 1;
		}
		if (metric === undefined) {
			for (const line of part.preview.split("\n")) {
				const m = METRIC_LINE.exec(line);
				if (m?.[1]) {
					metric = m[1];
					break;
				}
			}
		}
	}

	const clauses: string[] = [];
	if (counts.reads > 0) clauses.push(`read ${counts.reads} ${counts.reads === 1 ? "file" : "files"}`);
	if (counts.searches > 0) clauses.push(`${counts.searches} ${counts.searches === 1 ? "search" : "searches"}`);
	if (counts.commands > 0) clauses.push(`ran ${counts.commands} ${counts.commands === 1 ? "command" : "commands"}`);
	if (counts.writes > 0) clauses.push(`wrote ${counts.writes} ${counts.writes === 1 ? "file" : "files"}`);
	if (counts.edits > 0) clauses.push(`made ${counts.edits} ${counts.edits === 1 ? "edit" : "edits"}`);
	if (counts.others > 0) clauses.push(`${counts.others} ${counts.others === 1 ? "tool call" : "tool calls"}`);

	const secs = Math.max(1, Math.round(elapsedMs / 1000));
	if (clauses.length === 0) return `No tools used (${secs}s)`;
	const sentence = clauses.join(", ");
	return `${sentence}${metric ? `, metric ${metric}` : ""} (${secs}s)`;
}
