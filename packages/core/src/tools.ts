import { realpath } from "node:fs/promises";
import {
	type AgentHarnessTool,
	type AgentTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionEnv,
	getOrThrow,
} from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { z } from "zod";
import { shellQuote } from "./execution/ssh.ts";
import { isSensitiveFile } from "./sensitive.ts";
import { truncateWithMarker } from "./text.ts";

// Character budget shared by every tool result text (single source: timeouts.ts budget table).
const MAX_OUTPUT_CHARS = MAX_TOOL_RESULT_CHARS;

const SENSITIVE_REFUSAL =
	"refused: known secret file (.env, SSH private keys, credential files). Templates (.env.example/.sample/.template) and public keys (*.pub) are exempt.";

// Symlink anti-bypass: resolve the path with realpath and run the same sensitive check on the resolved target
// (notes.txt -> .env would slip past a string-only check). On realpath failure (missing file / dangling link)
// fall back to the original path so writing new files is not wrongly blocked. Exported for reuse by tools-media.
export async function resolveGuardTarget(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return path;
	}
}

// Sensitive-file guard: Read/Write/Edit refuse known secret files, fail-closed with no approval exemption.
function withSensitiveGuard<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
): AgentTool<TParameters, TDetails> {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const path = (params as { path?: unknown })?.path;
			if (typeof path === "string") {
				const resolved = await resolveGuardTarget(path);
				if (isSensitiveFile(path) || isSensitiveFile(resolved)) {
					// pi tool error semantics: a rejected promise → error tool result (isError set by the framework)
					throw new Error(SENSITIVE_REFUSAL);
				}
			}
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}

const LEDGER_REFUSAL =
	"refused: the .kea ledger (mobai/criteria/progress/journal/memory/sessions/trust) is mutated only through the research tools (start_goal, update_goal, log_progress, journal_note, remember) — direct writes bypass the schema guards (immutable criteria, complete-only-by-check_goal). Reading is allowed.";

/** Ledger mutation rule shared by the write/edit tool descriptions (same semantics as LEDGER_REFUSAL). */
const LEDGER_HINT =
	"the ledger changes ONLY through the research tools (start_goal, log_progress, journal_note, remember); reading it stays open.";

/** Any path containing a `.kea` segment: the workspace ledger (<cwd>/.kea/…) and the kea home (~/.kea/…, incl. trusted-folders.json). */
export function isKeaLedgerPath(path: string): boolean {
	// segment comparison is case-folded: on case-insensitive filesystems `.KEA` IS the `.kea` tree
	// (same semantics as permission.ts normalizePath); a case-sensitive check lets `.KEA/mobai/x.json` bypass
	const segments = path.replace(/\\/g, "/").split("/");
	return segments.some((s) => s.toLowerCase() === ".kea");
}

// Lexically fold `.`/`..` segments (resolve-fold semantics as in permission.ts canonicalPath; a `..` that
// cannot fold past the root/`~` anchor is kept). Writability MUST be judged on the folded form: a literal
// segment check lets `.kea/plans/../mobai/x.json` pass as plans and land inside `.kea/mobai`.
function foldPathSegments(path: string): string[] {
	const parts: string[] = [];
	for (const part of path.replace(/\\/g, "/").split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length > 0 && parts[parts.length - 1] !== "~" && parts[parts.length - 1] !== "..") parts.pop();
			else parts.push(part);
			continue;
		}
		parts.push(part);
	}
	return parts;
}

/** `.kea` is the harness-private tree; `plans` is the ONLY model-writable namespace inside it (the
 *  plan store lives at `~/.kea/plans/`). Writability by contract, not by exemption patch. Both segment
 *  comparisons are case-folded (case-insensitive filesystems — same semantics as isKeaLedgerPath). */
function isModelWritablePlansPath(path: string): boolean {
	const segments = foldPathSegments(path);
	const i = segments.findIndex((s) => s.toLowerCase() === ".kea");
	return i !== -1 && segments[i + 1]?.toLowerCase() === "plans";
}

/**
 * Ledger integrity guard (write/edit only; reads stay open): mobai.json criteria are immutable and
 * complete is only settable by check_goal, but a direct file write would bypass both (a sycophantic
 * self-completion or criteria shrink), and writing ~/.kea/trusted-folders.json would be a
 * self-trust escalation. The research tools are the only sanctioned mutation path; the plans
 * namespace is the sole pass-through.
 */
function withLedgerGuard<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
): AgentTool<TParameters, TDetails> {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const path = (params as { path?: unknown })?.path;
			if (typeof path === "string") {
				const resolved = await resolveGuardTarget(path);
				if (
					(isKeaLedgerPath(path) && !isModelWritablePlansPath(path)) ||
					(isKeaLedgerPath(resolved) && !isModelWritablePlansPath(resolved))
				) {
					throw new Error(LEDGER_REFUSAL);
				}
			}
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}

export function truncateOutput(text: string, limit = MAX_OUTPUT_CHARS): string {
	return truncateWithMarker(text, limit, `\n… [output truncated at ${limit} chars]`);
}

// Erase a concretely-typed tool into AgentTool (pi dispatches only on name/execute). execute is loosely typed:
// object-literal tool factories get widened return inference (executionMode: string, content block type becomes
// string), which won't fit AgentTool's strict shape; a structural cast keeps the identity fields.
export function asTool(tool: {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
	executionMode?: string;
	execute: (
		toolCallId: string,
		params: never,
		signal?: AbortSignal,
		onUpdate?: (partialResult: unknown) => void,
	) => Promise<unknown>;
}): AgentTool {
	return tool as AgentTool;
}

interface EnvToolContext {
	env: ExecutionEnv;
}

function bind<TParameters extends TSchema, TDetails>(
	tool: AgentHarnessTool<EnvToolContext, TParameters, TDetails>,
	env: ExecutionEnv,
): AgentTool<TParameters, TDetails> {
	return {
		...tool,
		execute: (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate, { env }),
	};
}

interface SearchToolSpec<P extends z.ZodType, D> {
	name: string;
	label: string;
	description: string;
	schema: P;
	maxOutput: { kind: "lines" | "results"; limit: number };
	run(params: z.input<P>, env: ExecutionEnv, signal: AbortSignal | undefined): Promise<{ body: string; details: D }>;
}

// Tool parameter schemas are zod (single source with runtime validation) exported to pi as JSON Schema via
// z.toJSONSchema; z.input carries the execute-side parameter type.
function defineSearchTool<P extends z.ZodType, D>(spec: SearchToolSpec<P, D>, env: ExecutionEnv): AgentTool {
	return asTool({
		name: spec.name,
		label: spec.label,
		description: spec.description,
		parameters: z.toJSONSchema(spec.schema),
		async execute(_toolCallId: string, params: z.input<P>, signal?: AbortSignal) {
			const { body, details } = await spec.run(params, env, signal);
			return { content: [{ type: "text", text: truncateOutput(body) }], details };
		},
	});
}

// rg availability probe: `command -v rg` exits 0 exactly when rg is on PATH; cached per tool instance so a
// session probes once (each createBaseTools call builds fresh tools — tests with fake exec envs re-probe).
function createRipgrepProbe() {
	let cached: boolean | undefined;
	return async (env: ExecutionEnv): Promise<boolean> => {
		if (cached === undefined) {
			const probe = await env.exec("command -v rg");
			cached = probe.ok && probe.value.exitCode === 0;
		}
		return cached;
	};
}

/** Throw a tool error summarizing a failed search subprocess (exit >= 2 means a real failure, not "no matches"). */
function searchFailure(tool: "grep" | "glob", exitCode: number, stderr: string): Error {
	return new Error(`${tool} failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
}

const grepParameters = z.strictObject({
	pattern: z.string().meta({ description: "Regular expression to search for" }),
	path: z.string().optional().meta({ description: "File or directory to search (default: cwd)" }),
});

function grepTool(env: ExecutionEnv) {
	const MAX_GREP_LINES = 200;
	const probe = createRipgrepProbe();
	return defineSearchTool(
		{
			name: "grep",
			label: "Grep",
			description: [
				"Search file contents with a regular expression (ripgrep if available, grep otherwise); returns matching lines as path:line:content.",
				"Output is capped at 200 matching lines; matches from known secret files are filtered out.",
				"Use this INSTEAD of running grep/rg through bash. To find files by name use glob; to read a known path use read.",
			].join("\n"),
			schema: grepParameters,
			maxOutput: { kind: "lines", limit: MAX_GREP_LINES },
			async run(params, execEnv, signal) {
				// single-file search on a sensitive path must be refused up front: its path:content output
				// defeats the line-level output filter (auto mode sits before the sensitive-file ask)
				if (typeof params.path === "string") {
					const resolved = await resolveGuardTarget(params.path);
					if (isSensitiveFile(params.path) || isSensitiveFile(resolved)) {
						throw new Error(SENSITIVE_REFUSAL);
					}
				}
				const target = params.path ?? ".";
				// rg/grep exit codes agree: 0 = matches, 1 = no matches (NOT an error), >= 2 = real failure
				// (surfaced with stderr). The grep FALLBACK must use ERE (`-E`): rg patterns are ERE-shaped
				// (`foo|bar`, `a+`) and a POSIX-BRE fallback would silently match them as literals. GNU grep has
				// no --hidden, so the fallback misses dotfiles (rg searches them via --hidden).
				const useRg = await probe(execEnv);
				const command = useRg
					? `rg -n --no-heading --color=never --hidden -- ${shellQuote(params.pattern)} ${shellQuote(target)}`
					: `grep -rnE -- ${shellQuote(params.pattern)} ${shellQuote(target)}`;
				const result = getOrThrow(await execEnv.exec(command, { abortSignal: signal, timeout: 60 }));
				if (result.exitCode >= 2) {
					throw searchFailure("grep", result.exitCode, result.stderr);
				}
				// filter result lines that hit sensitive files (rg/grep output is path:line:content).
				// Lines without a colon (like rg's "Binary file … matches") are treated whole as a path —
				// with indexOf -1, slice(0, -1) would cut the last character and misjudge.
				const lines = result.stdout.split("\n").filter((line) => {
					if (line === "") return true;
					const colonIdx = line.indexOf(":");
					const pathPart = colonIdx === -1 ? line : line.slice(0, colonIdx);
					return pathPart === "" || !isSensitiveFile(pathPart);
				});
				const body =
					lines.length > MAX_GREP_LINES
						? `${lines.slice(0, MAX_GREP_LINES).join("\n")}\n… [${lines.length - MAX_GREP_LINES} more matches]`
						: lines.join("\n");
				return {
					body: body === "" ? "No matches." : body,
					details: { matches: Math.min(lines.length, MAX_GREP_LINES) },
				};
			},
		},
		env,
	);
}

const globParameters = z.strictObject({
	pattern: z.string().meta({ description: "Glob pattern, e.g. **/*.ts" }),
	path: z.string().optional().meta({ description: "Directory to search (default: cwd)" }),
	include_ignored: z.boolean().optional().meta({
		description:
			"Also include files excluded by ignore files (.gitignore/.ignore/.rgignore — e.g. node_modules or build outputs); defaults to false. Known secret files stay filtered either way.",
	}),
});

function globTool(env: ExecutionEnv) {
	const MAX_GLOB_RESULTS = 100;
	// scan hard cap: collect a bit more than needed for mtime sorting, without walking a huge directory
	const MAX_GLOB_SCAN = MAX_GLOB_RESULTS * 4;
	const probe = createRipgrepProbe();
	return defineSearchTool(
		{
			name: "glob",
			label: "Glob",
			description: [
				"Find files by glob pattern, sorted by modification time (newest first).",
				"Ignore files are honored (.gitignore/.ignore/.rgignore): ignored paths like node_modules or build outputs are skipped unless include_ignored is true.",
				"Caps: at most 100 results are shown and the scan stops at 400 matches; known secret files are filtered out.",
				"Use to locate files by name or extension. To search file contents use grep; to read a found file use read.",
			].join("\n"),
			schema: globParameters,
			maxOutput: { kind: "results", limit: MAX_GLOB_RESULTS },
			async run(params, execEnv, signal) {
				const root = getOrThrow(await execEnv.absolutePath(params.path ?? "."));
				signal?.throwIfAborted();
				if (await probe(execEnv)) {
					// rg enumerates with its native three-layer ignore handling (.gitignore/.ignore/.rgignore) —
					// Bun.Glob.scan reads none of them. The user pattern is deliberately NOT passed as rg --glob:
					// a whitelisting --glob overrides ignore rules and would re-include exactly what the ignore
					// files exclude; instead rg lists (--sortr=modified, newest-first) and Bun.Glob.match keeps
					// pattern semantics. cwd is pinned to the root so rg prints root-relative paths.
					// --no-require-git honors .gitignore even outside a git repository.
					const command = [
						"rg --files --hidden --no-config --no-require-git --sortr=modified",
						params.include_ignored ? "--no-ignore" : "",
						"-- .",
					]
						.filter(Boolean)
						.join(" ");
					const result = getOrThrow(await execEnv.exec(command, { cwd: root, abortSignal: signal, timeout: 60 }));
					// rg --files exit codes: 0 = listed (possibly empty), 1 = no matching files, >= 2 = error.
					if (result.exitCode >= 2) {
						throw searchFailure("glob", result.exitCode, result.stderr);
					}
					const matcher = new Bun.Glob(params.pattern);
					const found: string[] = [];
					for (const line of result.stdout.split("\n")) {
						const file = line.replace(/^\.\//, "");
						if (file === "" || !matcher.match(file)) continue;
						// sensitive files are always filtered
						if (isSensitiveFile(`${root}/${file}`)) continue;
						found.push(file);
						if (found.length >= MAX_GLOB_SCAN) break;
					}
					return {
						body: formatGlobResults(found, MAX_GLOB_RESULTS, MAX_GLOB_SCAN),
						details: { count: Math.min(found.length, MAX_GLOB_RESULTS) },
					};
				}
				// rg unavailable: Bun.Glob.scan fallback (keep usable anywhere). Limitation: ignore files are
				// NOT honored on this path — rg presence is what gives .gitignore/.ignore/.rgignore semantics.
				const glob = new Bun.Glob(params.pattern);
				const found: Array<{ path: string; mtimeMs: number }> = [];
				for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
					// interruptible per file: the stat loop can be long, checking once at entry is not enough
					signal?.throwIfAborted();
					// sensitive files are always filtered
					if (isSensitiveFile(`${root}/${file}`)) continue;
					const stat = await Bun.file(`${root}/${file}`)
						.stat()
						.catch(() => undefined);
					found.push({ path: file, mtimeMs: stat?.mtimeMs ?? 0 });
					if (found.length >= MAX_GLOB_SCAN) break;
				}
				found.sort((a, b) => b.mtimeMs - a.mtimeMs);
				return {
					body: formatGlobResults(
						found.map((f) => f.path),
						MAX_GLOB_RESULTS,
						MAX_GLOB_SCAN,
					),
					details: { count: Math.min(found.length, MAX_GLOB_RESULTS) },
				};
			},
		},
		env,
	);
}

// Shared result formatting for both glob paths (wording pinned by tests): newest first, capped at the display
// limit, honest note when the scan hard cap was hit.
function formatGlobResults(found: string[], maxResults: number, maxScan: number): string {
	const results = found.slice(0, maxResults);
	const more =
		found.length > maxResults
			? found.length >= maxScan
				? `\n… [capped at ${maxResults} results; scan stopped at ${maxScan} matches]`
				: `\n… [capped at ${maxResults} results]`
			: "";
	return results.length === 0 ? "No files matched." : results.join("\n") + more;
}

// bash timeout guard: pi's bash tool ships with NO default timeout, so one pathological command (a `find /`
// disk scan) silently stalls an entire round. When the model omits a timeout, apply a 300s default; clamp
// explicit timeouts at 1h — longer work belongs in the jobs system, not a blocking bash call.
import { BASH_DEFAULT_TIMEOUT_S, BASH_MAX_TIMEOUT_S, MAX_TOOL_RESULT_CHARS } from "./timeouts.ts";

export { BASH_DEFAULT_TIMEOUT_S, BASH_MAX_TIMEOUT_S };

/** Effective bash timeout: default when omitted, clamped to [1s, cap] when explicit (<=0 must not fall back to pi's no-timeout semantics). */
export function bashEffectiveTimeout(timeout: number | undefined): number {
	return timeout === undefined ? BASH_DEFAULT_TIMEOUT_S : Math.min(Math.max(1, timeout), BASH_MAX_TIMEOUT_S);
}

function withBashTimeout(tool: AgentTool): AgentTool {
	const execute = tool.execute.bind(tool);
	return {
		...tool,
		description: `${tool.description}\nTimeout: defaults to ${BASH_DEFAULT_TIMEOUT_S}s when omitted, maximum ${BASH_MAX_TIMEOUT_S}s — pass an explicit timeout for long builds; use the jobs system for anything longer.`,
		execute: (toolCallId, params, signal, onUpdate) => {
			const p = params as { command?: string; timeout?: number };
			return execute(toolCallId, { ...p, timeout: bashEffectiveTimeout(p.timeout) }, signal, onUpdate);
		},
	};
}

// pi's bash schema plus a per-call working directory.
const bashParameters = z.strictObject({
	command: z.string().meta({ description: "Bash command to execute" }),
	timeout: z.number().optional().meta({ description: "Timeout in seconds (optional, no default timeout)" }),
	cwd: z.string().optional().meta({ description: "Working directory (default: cwd)" }),
});

// Per-call cwd for bash: pi's bash schema has no cwd parameter, but its BashExecution object is mutable and
// exposed through the createBashTool prepare hook — the sanctioned injection point. A fresh tool instance per
// call captures that call's cwd in its prepare closure (concurrent calls cannot race); the no-cwd path reuses
// the pre-bound instance.
function withBashCwd(tool: AgentTool, env: ExecutionEnv): AgentTool {
	const execute = tool.execute.bind(tool);
	return {
		...tool,
		parameters: z.toJSONSchema(bashParameters),
		execute: (toolCallId, params, signal, onUpdate) => {
			const { cwd, ...rest } = params as { command?: string; timeout?: number; cwd?: string };
			if (cwd === undefined) {
				return execute(toolCallId, rest, signal, onUpdate);
			}
			// ShellExecOptions.cwd resolves relative paths against env.cwd, so raw params pass through unchanged.
			const perCall = createBashTool({
				prepare: (execution) => {
					execution.cwd = cwd;
				},
			});
			return perCall.execute(toolCallId, rest as { command: string; timeout?: number }, signal, onUpdate, { env });
		},
	};
}

/**
 * Base-tool descriptions (kimi paradigm, style contract §10.1: one-sentence definition → machine contract
 * semantics with REFUSED/NEVER/ONLY caps → when to use / not use with dedup and escalation paths).
 * They replace pi's shipped descriptions so the model sees Kea's guard semantics (sensitive files, .kea ledger).
 */
const BASH_DESCRIPTION = [
	"Execute a bash command and return stdout and stderr.",
	"Each call runs in a FRESH shell: cd, exported variables, and background jobs do NOT persist between calls.",
	"A non-zero exit code returns an error result that still contains the output; a timeout kills the command and returns an error.",
	"Output is truncated to the last 2000 lines / 50KB; when truncated, the full output path is included.",
	"Use for shell semantics: pipes, git, package managers, build/test runners, multi-step sequences.",
	"Do NOT use bash to read a known file (use read), search file contents (use grep), or find files by name (use glob).",
].join("\n");

const READ_DESCRIPTION = [
	"Read a file from the local filesystem. Text files return their content; images (jpg, png, gif, webp, bmp) are returned as attachments.",
	"Text output is truncated to 2000 lines / 50KB; use offset/limit to page through a large file. Known secret files (.env, SSH private keys, credential files) are REFUSED — templates and public keys are exempt.",
	"When you know the path, read it directly; do NOT glob or ls first to confirm it exists. To locate files by pattern use glob; to search contents use grep.",
].join("\n");

const WRITE_DESCRIPTION = [
	"Create a file or replace its contents entirely; parent directories are created automatically.",
	`REFUSED: known secret files, and any .kea path except .kea/plans/** — ${LEDGER_HINT}`,
	"Use for new files and full rewrites. For incremental changes to an existing file use edit — NEVER rewrite a whole file just to change a few lines.",
].join("\n");

const EDIT_DESCRIPTION = [
	"Edit an existing file through exact-text replacements.",
	"Each edits[].oldText must match EXACTLY ONE region of the current file; a missing or ambiguous match fails the whole call. Read the file before editing and take oldText from what you actually read.",
	`REFUSED: known secret files and any .kea path except .kea/plans/** — ${LEDGER_HINT}`,
	"Do NOT include large unchanged regions to connect distant changes; merge nearby changes into one edit instead of overlapping ones.",
].join("\n");

/** Override a tool's description while preserving its concrete type (spread literals widen and lose assignability to AgentTool). */
function withDescription<T extends { description: string }>(tool: T, description: string): T {
	return { ...tool, description };
}

export function createBaseTools(env: ExecutionEnv): AgentTool[] {
	return [
		withBashTimeout(withDescription(withBashCwd(bind(createBashTool(), env), env), BASH_DESCRIPTION)),
		withSensitiveGuard(withDescription(bind(createReadTool(), env), READ_DESCRIPTION)),
		withLedgerGuard(withSensitiveGuard(withDescription(bind(createWriteTool(), env), WRITE_DESCRIPTION))),
		withLedgerGuard(withSensitiveGuard(withDescription(bind(createEditTool(), env), EDIT_DESCRIPTION))),
		asTool(grepTool(env)),
		asTool(globTool(env)),
	];
}
