import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatElapsed } from "../../constants/format.ts";
import { BRANCH_BULLET, FAILURE_MARK } from "../../constants/symbols.ts";
import type { ThemeStyles } from "../../theme.ts";
import { MIN_WRAP_WIDTH, WidthCache } from "./render-cache.ts";
import { getToolRenderer } from "./tool-renderers/index.ts";

const COLLAPSED_LINES = 3;
/** Separate line budget for bash commands, counted apart from the result preview. */
const COMMAND_COLLAPSED_LINES = 3;
const TAIL_LINES = 3;
const TAIL_BUFFER_LIMIT = 50_000;
const MAX_ARG_LENGTH = 60;

function toolVerb(name: string, status: ToolStatus): string {
	if (name === "bash") return status === "running" ? "Running a command" : "Ran a command";
	return status === "running" ? `Using ${name}` : `Used ${name}`;
}

export type ToolStatus = "running" | "done" | "error";

export interface ToolCallViewOptions {
	name: string;
	args: unknown;
	cwd: string;
	styles: ThemeStyles;
	isExpanded: () => boolean;
	requestRender: () => void;
}

const KEY_ARG_MAP: Record<string, string[]> = {
	read: ["path"],
	write: ["path"],
	edit: ["path"],
	grep: ["pattern"],
	glob: ["pattern"],
	fetch_url: ["url"],
	web_search: ["query"],
	read_media_file: ["path"],
};
const FALLBACK_KEYS = ["command", "path", "pattern", "query"];

export interface KeyArgOptions {
	keys?: readonly string[];
	anyValue?: boolean;
	relativize?: boolean;
	firstLine?: boolean;
	/** Flatten whitespace to a single space; the line is taken first, then flattened. */
	flatten?: boolean;
	truncate?: "head" | "tail";
	maxLength?: number;
}

export function extractKeyArgument(name: string, args: unknown, cwd: string, options: KeyArgOptions = {}): string {
	if (typeof args !== "object" || args === null) return "";
	const a = args as Record<string, unknown>;
	const str = (v: unknown): string => (typeof v === "string" ? v : "");
	const keys = options.keys ?? KEY_ARG_MAP[name] ?? FALLBACK_KEYS;
	let text = "";
	if (name === "bash") {
		text = str(a.command);
	} else {
		for (const key of keys) {
			text = str(a[key]);
			if (text !== "") break;
		}
		if (text === "" && options.anyValue === true) {
			for (const value of Object.values(a)) {
				if (typeof value === "string" && value.trim() !== "") {
					text = value;
					break;
				}
			}
		}
	}
	if (name === "bash" || options.firstLine === true) text = text.split("\n")[0] ?? "";
	if ((options.relativize ?? true) && cwd !== "" && text.startsWith(`${cwd}/`)) text = text.slice(cwd.length + 1);
	if (options.flatten ?? true) text = text.replace(/\s+/g, " ");
	const maxLength = options.maxLength ?? MAX_ARG_LENGTH;
	if (text.length <= maxLength) return text;
	return options.truncate === "tail" ? `…${text.slice(text.length - (maxLength - 1))}` : `${text.slice(0, maxLength)}…`;
}

export class ToolCallView implements Component {
	status: ToolStatus = "running";
	readonly flushLeft = true;

	get junctionPaint(): (s: string) => string {
		if (this.status === "error") return this.options.styles.error;
		if (this.status === "done") return this.options.styles.success;
		return this.options.styles.primary;
	}
	private durationMs = 0;
	private preview = "";
	private tailBuffer = "";
	private details: unknown;

	// Width-keyed render cache (pi renders the whole tree every frame, so finalized cards must hit it).
	// FINISHED inputs are immutable; expanded must stay in dep — Ctrl+O only requests render, never
	// invalidates the component, so leaving it out would freeze the expanded form in the stale cache.
	private readonly cache = new WidthCache();
	// Status-flip guard: the first render after finish must recompute.
	private cacheState: ToolStatus = "running";

	constructor(private readonly options: ToolCallViewOptions) {}

	invalidate(): void {
		this.cache.invalidate();
	}

	// Redraw is requested centrally by the tool_update merger, not per-line here.
	appendLiveText(text: string): void {
		if (text === "") return;
		const merged = this.tailBuffer + text;
		this.tailBuffer =
			merged.length > TAIL_BUFFER_LIMIT ? `[...truncated]\n${merged.slice(-TAIL_BUFFER_LIMIT)}` : merged;
	}

	finish(result: { durationMs: number; preview: string; isError: boolean; details?: unknown }): void {
		this.status = result.isError ? "error" : "done";
		this.durationMs = result.durationMs;
		this.preview = result.preview;
		this.details = result.details;
		// Defensive: a double finish would render a stale cache — the FINISHED dep has no content fields.
		this.cache.invalidate();
		this.options.requestRender();
	}

	render(width: number): string[] {
		const expanded = this.options.isExpanded();
		const deps: readonly unknown[] =
			this.status === "running" ? [this.status, this.tailBuffer, expanded] : [this.status, expanded];
		if (this.cacheState !== this.status) {
			this.cache.invalidate();
			this.cacheState = this.status;
		}
		return this.cache.render(width, deps, (w) => this.computeRender(w));
	}

	private computeRender(width: number): string[] {
		const { styles, name } = this.options;
		const lines: string[] = [this.renderHeader(width)];
		if (this.status === "running") {
			const runningBody: string[] = [];
			if (name === "bash") {
				const cmd = commandOf(this.options.args);
				if (cmd !== "") runningBody.push(styles.dim(`  $ ${cmd}`));
			}
			for (const line of tailVisualLines(this.tailBuffer, width, styles))
				runningBody.push(`  ${styles.faint("│")} ${line}`);
			return [...lines, ...collapse(runningBody, width, true, styles)];
		}
		const renderer = getToolRenderer(name);
		const body = renderer.bodyLines({
			name,
			styles,
			args: this.options.args,
			details: this.details,
			preview: this.preview,
			isError: this.status === "error",
			durationMs: this.durationMs,
		});
		const expanded = this.options.isExpanded();
		const cmd = name === "bash" ? commandOf(this.options.args) : "";
		const cmdLines = cmd !== "" ? commandPreview(`$ ${cmd}`, width, expanded, styles).map((l) => `  ${l}`) : [];
		return [
			...lines,
			...cmdLines,
			...collapse(
				body.map((l) => `  ${l}`),
				width,
				expanded,
				styles,
			),
		];
	}

	private renderHeader(width: number): string {
		const { styles, name } = this.options;
		const keyArg = name === "bash" ? "" : extractKeyArgument(name, this.options.args, this.options.cwd);
		const argStr = keyArg !== "" ? ` ${styles.dim(`(${keyArg})`)}` : "";

		if (this.status === "running") {
			const head = `${styles.primary(styles.bold(`${BRANCH_BULLET}${toolVerb(name, "running")}`))}${argStr}`;
			return truncateToWidth(head, Math.max(width - 2, 10));
		}

		const renderer = getToolRenderer(name);
		const chips = [
			// durationMs=0 comes from transcript replay (no timing data); don't show a noisy chip
			...(this.durationMs > 0 ? [formatElapsed(this.durationMs)] : []),
			...renderer.chips({
				name,
				styles,
				args: this.options.args,
				details: this.details,
				preview: this.preview,
				isError: this.status === "error",
				durationMs: this.durationMs,
			}),
		];
		const chipTone = this.status === "error" ? styles.error : styles.dim;
		const chipStr = chips.length > 0 ? ` ${chipTone(`· ${chips.join(" · ")}`)}` : "";
		if (this.status === "error") {
			const head = `${styles.error(`${FAILURE_MARK} `)}${styles.error(styles.bold(toolVerb(name, this.status)))}${argStr}`;
			return truncateToWidth(`${head}${chipStr}`, width, "…");
		}
		const head = `${styles.success(BRANCH_BULLET)}${styles.primary(styles.bold(toolVerb(name, this.status)))}${argStr}`;
		return truncateToWidth(`${head}${chipStr}`, width, "…");
	}
}

function commandOf(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const c = (args as Record<string, unknown>).command;
	return typeof c === "string" ? c : "";
}

export function contentTextOf(value: unknown): string {
	if (typeof value !== "object" || value === null) return "";
	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && b.type === "text")
		.map((b) => b.text)
		.join("");
}

// Tail window: scan backward for TAIL_LINES+1 raw newlines and wrap only that window (the start always
// lands on a raw line boundary). hidden = raw lines before the window + wrap overflow inside it; long
// pre-window lines undercount their wrap overflow — affects only the hint number, visible lines are
// identical to a full wrap.
export function tailVisualLines(buffer: string, width: number, styles: ThemeStyles): string[] {
	if (buffer === "") return [];
	const text = buffer.replace(/\n$/, "");
	const wrapWidth = Math.max(width - 4, MIN_WRAP_WIDTH);
	let windowStart = 0;
	let newlines = 0;
	for (let i = text.length - 1; i >= 0; i--) {
		if (text.charCodeAt(i) === 10) {
			newlines += 1;
			if (newlines === TAIL_LINES + 1) {
				windowStart = i + 1;
				break;
			}
		}
	}
	const rawBefore = windowStart > 0 ? text.slice(0, windowStart - 1).split("\n").length : 0;
	const wrapped = wrapTextWithAnsi(text.slice(windowStart), wrapWidth);
	const shown = wrapped.slice(-TAIL_LINES);
	const out = shown.map((l) => styles.dim(l));
	const hidden = rawBefore + (wrapped.length - shown.length);
	if (hidden > 0) out.unshift(styles.faint(`… (${hidden} earlier lines)`));
	return out;
}

function commandPreview(cmd: string, width: number, expanded: boolean, styles: ThemeStyles): string[] {
	const wrapWidth = Math.max(width, MIN_WRAP_WIDTH);
	const wrapped = wrapTextWithAnsi(styles.dim(cmd), wrapWidth);
	if (expanded || wrapped.length <= COMMAND_COLLAPSED_LINES) return wrapped;
	const shown = wrapped.slice(0, COMMAND_COLLAPSED_LINES);
	const lastIdx = shown.length - 1;
	shown[lastIdx] = truncateToWidth(shown[lastIdx] ?? "", wrapWidth, "…");
	return shown;
}

// Counting uses post-wrap visual rows; an over-long first row still shows at least its first visual
// row — no tool may degrade to zero preview.
export function collapse(lines: string[], width: number, expanded: boolean, styles: ThemeStyles): string[] {
	if (lines.length === 0) return [];
	const wrapWidth = Math.max(width, MIN_WRAP_WIDTH);
	if (expanded) return lines.flatMap((line) => wrapTextWithAnsi(line, wrapWidth));
	const wrappedAll = lines.map((line) => wrapTextWithAnsi(line, wrapWidth));
	const out: string[] = [];
	let visible = 0;
	let consumedLines = 0;
	for (const wrapped of wrappedAll) {
		if (visible + wrapped.length > COLLAPSED_LINES) break;
		out.push(...wrapped);
		visible += wrapped.length;
		consumedLines += 1;
	}
	if (consumedLines === 0) {
		const head = (wrappedAll[0] ?? [])[0];
		if (head !== undefined) {
			out.push(head);
			visible = 1;
		}
	}
	const hidden = wrappedAll.reduce((n, w) => n + w.length, 0) - visible;
	if (hidden > 0) {
		out.push(styles.faint(`  … (${hidden} more lines, Ctrl+O to expand)`));
	}
	return out;
}
