import { join } from "node:path";
import { z } from "zod";

export const HOOK_EVENTS = [
	"UserPromptSubmit",
	"UserPromptQueued",
	"PreToolUse",
	"PostToolUse",
	"Stop",
	"Interrupt",
	"SessionStart",
	"SessionEnd",
	"PreCompact",
	"PostCompact",
	"SubagentStart",
	"SubagentStop",
	"JobSubmitted",
	"JobFinished",
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/** Drain grace after timeout kill: a grandchild may hold the pipe, so drain must not wait forever */
const DRAIN_GRACE_MS = 1_000;

/** SIGTERM → SIGKILL grace: a hook that ignores SIGTERM must be force-killed, never hang fireBlocking */
const KILL_GRACE_MS = 1_000;

const HookEntrySchema = z.object({
	command: z.string(),
	timeoutMs: z.number().positive().max(60_000).optional(),
	/** Regex matched against the event target (tool name/prompt text/source/reason/trigger); consulted only for matcher-target events (Pre/PostToolUse, UserPromptSubmit/Queued, SessionStart/End, Pre/PostCompact) — ignored elsewhere. Empty or omitted = match all, invalid regex = match none */
	matcher: z.string().optional(),
});

const HookEntries = z.array(HookEntrySchema).optional();

const HooksConfigSchema = z.object({
	// zod v4's z.record(z.enum(...)) requires all enum keys to be present — use per-event optional fields so only some events may be configured
	hooks: z
		.object({
			UserPromptSubmit: HookEntries,
			UserPromptQueued: HookEntries,
			PreToolUse: HookEntries,
			PostToolUse: HookEntries,
			Stop: HookEntries,
			Interrupt: HookEntries,
			SessionStart: HookEntries,
			SessionEnd: HookEntries,
			PreCompact: HookEntries,
			PostCompact: HookEntries,
			SubagentStart: HookEntries,
			SubagentStop: HookEntries,
			JobSubmitted: HookEntries,
			JobFinished: HookEntries,
		})
		.optional(),
});

export type HookEntry = z.infer<typeof HookEntrySchema>;
export type HooksConfig = z.infer<typeof HooksConfigSchema>;

export interface HookOutcome {
	blocked: boolean;
	reason?: string;
	/** hook stdout the caller may inject as context (UserPromptSubmit semantics): plain text only, non-empty, <2000 chars */
	output?: string;
}

/** Plain-text stdout carried as `output` only below this size (a hook dumping MBs must not flood injected context) */
const PLAIN_OUTPUT_MAX_CHARS = 2_000;

/** Truncate an already-stringified payload to the shared hook cap (same marker as stringifyToolInput). */
export function truncateToolInput(text: string): string {
	return text.length > PLAIN_OUTPUT_MAX_CHARS ? `${text.slice(0, PLAIN_OUTPUT_MAX_CHARS)}… [truncated]` : text;
}

/** JSON-stringify tool args for hook payloads (PostToolUse `tool_input`), truncated to 2000 chars; unserializable args → "" */
export function stringifyToolInput(args: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(args) ?? "";
	} catch {
		return "";
	}
	return truncateToolInput(text);
}

/**
 * PostToolUse payload contract (assembled by the kernel; snake_case envelope fields on top of these).
 * `tool_input` is the pre-stringified, truncated args; `tool_call_id` correlates with the tool_call message.
 */
export interface PostToolUseHookPayload extends Record<string, unknown> {
	tool_name: string;
	tool_input?: string;
	tool_call_id?: string;
	is_error?: boolean;
}

interface ParsedHookStdout {
	blocked?: boolean;
	reason?: string;
	output?: string;
}

// Structured stdout protocol: a hook may speak JSON instead of exit codes.
// - {"hookSpecificOutput":{"permissionDecision":"deny","message":…}} → block (same force as exit 2, reason from `message`)
// - {"decision":"block","reason":…} → block
// - non-JSON (or non-object JSON) stdout is plain text: carried as `output` only when non-empty and <2000 chars,
//   never changing blocking semantics. Parse failures never throw (fail-open).
export function parseHookStdout(stdout: string): ParsedHookStdout {
	const text = stdout.trim();
	if (text === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return text.length < PLAIN_OUTPUT_MAX_CHARS ? { output: text } : {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return text.length < PLAIN_OUTPUT_MAX_CHARS ? { output: text } : {};
	}
	const obj = parsed as Record<string, unknown>;
	const specific = obj.hookSpecificOutput;
	if (typeof specific === "object" && specific !== null && !Array.isArray(specific)) {
		const so = specific as Record<string, unknown>;
		if (so.permissionDecision === "deny") {
			const message =
				typeof so.message === "string" && so.message !== ""
					? so.message
					: typeof so.permissionDecisionReason === "string" && so.permissionDecisionReason !== ""
						? so.permissionDecisionReason
						: undefined;
			return { blocked: true, reason: message ?? "hook denied the tool call" };
		}
	}
	if (obj.decision === "block") {
		const reason = typeof obj.reason === "string" && obj.reason !== "" ? obj.reason : undefined;
		return { blocked: true, reason: reason ?? "hook blocked the run" };
	}
	return {};
}

/** Single-entry verdict: exit 2 keeps its stderr semantics; otherwise structured stdout may block or carry output. */
function evaluateHookResult(
	command: string,
	result: { exitCode: number; stderr: string; stdout?: string },
): HookOutcome {
	if (result.exitCode === 2) {
		return { blocked: true, reason: result.stderr.trim() || `hook blocked (${command})` };
	}
	const parsed = parseHookStdout(result.stdout ?? "");
	if (parsed.blocked === true) {
		return { blocked: true, reason: parsed.reason ?? `hook blocked (${command})` };
	}
	return parsed.output !== undefined ? { blocked: false, output: parsed.output } : { blocked: false };
}

/** Merge parallel per-hook outcomes: any blocked → blocked (reasons joined); any output → joined with newline. */
function mergeHookOutcomes(outcomes: readonly HookOutcome[]): HookOutcome {
	const blocked = outcomes.filter((o) => o.blocked);
	if (blocked.length > 0) {
		const reasons = blocked.map((o) => o.reason).filter((r): r is string => typeof r === "string" && r !== "");
		return reasons.length > 0 ? { blocked: true, reason: reasons.join("\n") } : { blocked: true };
	}
	const outputs = outcomes.map((o) => o.output).filter((o): o is string => typeof o === "string" && o !== "");
	return outputs.length > 0 ? { blocked: false, output: outputs.join("\n") } : { blocked: false };
}

/** Error thrown by prompt() when a UserPromptSubmit hook blocks (exit 2): the message is not written to the ledger and the run is not started */
export class HookBlockedError extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "HookBlockedError";
	}
}

export function hooksConfigPath(cwd: string): string {
	return join(cwd, ".kea", "hooks.json");
}

export async function loadHooksConfig(cwd: string): Promise<HooksConfig> {
	const file = Bun.file(hooksConfigPath(cwd));
	if (!(await file.exists())) return {};
	try {
		return HooksConfigSchema.parse(await file.json());
	} catch {
		return {};
	}
}

// Events whose matcher target applies; the matcher field is ignored for other events.
const MATCHER_TARGET_EVENTS: ReadonlySet<HookEventName> = new Set([
	// PreToolUse/PostToolUse → tool name; UserPromptSubmit/Queued → prompt text;
	// SessionStart → source; SessionEnd → reason; Pre/PostCompact → trigger
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"UserPromptQueued",
	"SessionStart",
	"SessionEnd",
	"PreCompact",
	"PostCompact",
]);

const matcherCache = new Map<string, RegExp | null>();

function compileMatcher(pattern: string): RegExp | null {
	const cached = matcherCache.get(pattern);
	if (cached !== undefined) return cached;
	let compiled: RegExp | null;
	try {
		compiled = new RegExp(pattern);
	} catch {
		compiled = null;
	}
	matcherCache.set(pattern, compiled);
	return compiled;
}

/** Session context hooks need. sessionId/model can change mid-session (session switch/setModel), so always sample lazily */
export interface HookContext {
	sessionId: () => string;
	cwd: string;
	model: () => string;
}

export class HookRunner {
	constructor(
		private readonly config: HooksConfig,
		private readonly context?: HookContext,
	) {}

	async fireBlocking(
		event: HookEventName,
		payload: Record<string, unknown>,
		matcherTarget?: string,
	): Promise<HookOutcome> {
		const entries = this.matchedEntries(event, matcherTarget);
		// parallel: hooks are independent processes, a slow hook must not serialize behind another.
		// fail-open per entry: a spawn/wait throw (e.g. EMFILE) counts as allow — hook failures must not
		// escalate to blocking or blow up prompt()/gateToolCall
		const outcomes = await Promise.all(
			entries.map(async (entry): Promise<HookOutcome | undefined> => {
				try {
					const result = await this.runOne(entry.command, entry.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS, event, payload);
					return evaluateHookResult(entry.command, result);
				} catch {
					return undefined;
				}
			}),
		);
		return mergeHookOutcomes(outcomes.filter((o): o is HookOutcome => o !== undefined));
	}

	// Awaits all Stop hooks and merges their decision. blocked:true → the caller must steer a continuation
	// instead of ending the turn (reason = why); `output` is hook stdout the caller may inject as context.
	// stop_hook_active tells the hook whether this Stop already follows a hook-requested continuation
	// in the same run chain (kimi loop-guard contract).
	async fireStop(outcome: string, stopHookActive = false): Promise<HookOutcome> {
		return this.fireBlocking("Stop", { outcome, stop_hook_active: stopHookActive });
	}

	fireAndForget(event: HookEventName, payload: Record<string, unknown>, matcherTarget?: string): void {
		for (const entry of this.matchedEntries(event, matcherTarget)) {
			const run: Promise<void> = (async () => {
				await this.runOne(entry.command, entry.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS, event, payload).catch(() => {});
			})();
			this.pending.add(run);
			void run.finally(() => this.pending.delete(run));
		}
	}

	/** Wait for all in-flight fire-and-forget hooks to finish (exit path: a headless process must not kill hooks that have not persisted). */
	async flush(): Promise<void> {
		while (this.pending.size > 0) {
			await Promise.allSettled([...this.pending]);
		}
	}

	private pending = new Set<Promise<void>>();

	private matchedEntries(event: HookEventName, matcherTarget?: string): HookEntry[] {
		const entries = this.config.hooks?.[event] ?? [];
		if (!MATCHER_TARGET_EVENTS.has(event)) return entries;
		return entries.filter((entry) => {
			if (!entry.matcher) return true;
			const compiled = compileMatcher(entry.matcher);
			if (compiled === null) return false; // invalid regex = match nothing
			return compiled.test(matcherTarget ?? "");
		});
	}

	private async runOne(
		command: string,
		timeoutMs: number,
		event: HookEventName,
		payload: Record<string, unknown>,
	): Promise<{ exitCode: number; stderr: string; stdout: string }> {
		// unified envelope: snake_case base fields + event-specific fields (caller already assembled them snake_case)
		const stdin = {
			hook_event_name: event,
			...(this.context
				? { session_id: this.context.sessionId(), cwd: this.context.cwd, model: this.context.model() }
				: {}),
			...payload,
		};
		const proc = Bun.spawn(["bash", "-c", command], {
			// trailing newline: hooks commonly do `cat >> log` to append; without a newline, repeated triggers would glue into one line
			stdin: new TextEncoder().encode(`${JSON.stringify(stdin)}\n`),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, KEA_HOOK_EVENT: event },
		});
		const timer = setTimeout(() => {
			proc.kill(); // SIGTERM
			setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					// already exited
				}
			}, KILL_GRACE_MS);
		}, timeoutMs);
		// both pipes start draining before awaiting anything: concurrent reads prevent the pipe-buffer deadlock
		// when a hook writes >64KB to both stdout and stderr; the bounded races below cap grandchild-held-fd latency.
		const stdoutDrain = new Response(proc.stdout).text().catch(() => "");
		const stderrDrain = new Response(proc.stderr).text().catch(() => "");
		// bounded exit wait: even if the hook survives SIGTERM, resolve with exit code -1 (fail-open) rather than awaiting proc.exited forever
		const exitCode = await Promise.race([
			proc.exited,
			Bun.sleep(timeoutMs + KILL_GRACE_MS + DRAIN_GRACE_MS).then(() => -1),
		]);
		clearTimeout(timer);
		const grace = Bun.sleep(DRAIN_GRACE_MS).then(() => "");
		const [stdout, stderr] = await Promise.all([
			Promise.race([stdoutDrain, grace]),
			Promise.race([stderrDrain, grace]),
		]);
		return { exitCode, stderr, stdout };
	}
}
