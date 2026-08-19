import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
	EMPTY_USER_PERMISSION_RULES,
	loadPermissionRules,
	permissionRuleMatches,
	type UserPermissionRules,
} from "./permission-rules.ts";
import { isSensitiveFile } from "./sensitive.ts";

export type PermissionMode = "manual" | "auto" | "yolo";

export type ToolAccessKind = "read" | "write" | "exec" | "unknown";

export interface ToolRequest {
	toolName: string;
	args: unknown;
	kind: ToolAccessKind;
	command?: string;
	path?: string;
}

export type PolicyVerdictKind = "approve" | "deny" | "ask";

export interface PolicyDecision {
	verdict: PolicyVerdictKind;
	ruleId: string;
	reason?: string;
}

/** Approval callback verdict: "approve"/"deny", or a structured deny whose feedback reaches the agent in the block reason. */
export type ApprovalDecision = "approve" | "deny" | { decision: "deny"; feedback: string };

export type ApprovalHandler = (req: ToolRequest) => Promise<ApprovalDecision>;

const READ_TOOLS = new Set(["read", "grep", "glob", "read_media_file"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

export function classifyTool(toolName: string): ToolAccessKind {
	if (toolName === "bash") return "exec";
	if (READ_TOOLS.has(toolName)) return "read";
	if (WRITE_TOOLS.has(toolName)) return "write";
	return "unknown";
}

export function pathOf(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const p = (args as Record<string, unknown>).path;
	return typeof p === "string" && p !== "" ? p : undefined;
}

// Path normalization: drop ./, collapse safely-collapsible .., unify separators, lowercase (rules must not be
// bypassed via case on case-insensitive filesystems). ~ stays a home marker (isWithin expands it); absolute
// paths keep their leading "/" so they never collide with a same-shaped relative path.
export function normalizePath(p: string): string {
	let s = p.trim().replace(/\\/g, "/");
	if (s.startsWith("./")) s = s.slice(2);
	const isAbsolute = s.startsWith("/");
	const parts: string[] = [];
	for (const part of s.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			// collapse only when the stack top is not ~ and not empty; keep the rest (don't guess what can't be statically resolved)
			if (parts.length > 0 && parts[parts.length - 1] !== "~" && parts[parts.length - 1] !== "..") parts.pop();
			else parts.push(part);
			continue;
		}
		parts.push(part);
	}
	const body = (parts.join("/") || ".").toLowerCase();
	return isAbsolute ? `/${body}` : body;
}

// Request identity: the matching key for the session-level "allow for this session" memory.
// bash → command literal; file tools → verb + normalized path (read and write identities are separate, and
// absolute paths stay absolute — approving `etc/passwd` in the workspace must never auto-approve `/etc/passwd`);
// others → tool name.
export function requestIdentity(req: ToolRequest): string {
	if (req.toolName === "bash") return `bash:${(req.command ?? "").trim()}`;
	if (req.kind === "read" || req.kind === "write") {
		if (req.path) return `${req.kind}:${normalizePath(req.path)}`;
	}
	return `tool:${req.toolName}`;
}

export class SessionApprovals {
	private readonly identities = new Set<string>();

	remember(req: ToolRequest): void {
		this.identities.add(requestIdentity(req));
	}

	matches(req: ToolRequest): boolean {
		return this.identities.has(requestIdentity(req));
	}

	clear(): void {
		this.identities.clear();
	}

	get size(): number {
		return this.identities.size;
	}
}

/** Walk up for .git (file or directory), return the work-tree root; non-git directories return undefined. Pure filesystem probe, no subprocess. */
export function findGitRoot(cwd: string): string | undefined {
	let dir = cwd;
	for (let i = 0; i < 64; i++) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

export interface PolicyContext {
	mode: PermissionMode;
	/** orthogonal plan mode: not mutually exclusive with permission; read-only enforced by the plan-readonly rule */
	planMode: boolean;
	/** science mode: mutually exclusive with planMode; read-only orchestration, enforced by the science-readonly rule */
	scienceMode: boolean;
	cwd: string;
	gitRoot: string | undefined;
	approvals: SessionApprovals;
	/** the only writable target in plan mode (the plan file path) */
	planFilePath: string | undefined;
	/** user-configured rules from kea.toml [permission] (empty when absent/untrusted — rules only tighten) */
	rules: UserPermissionRules;
}

/** Chain member: returning undefined = no opinion, defer to the next rule; order is priority. */
export interface PolicyRule {
	readonly id: string;
	decide(req: ToolRequest, ctx: PolicyContext): PolicyDecision | undefined;
}

function touchesGitInternals(p: string): boolean {
	const norm = normalizePath(p);
	return norm === ".git" || norm.startsWith(".git/") || norm.includes("/.git/") || norm.endsWith("/.git");
}

/**
 * Lexical canonicalization: expand a leading ~ (to homedir), then fold .. with path.resolve(cwd, p) —
 * a bare prefix comparison is bypassable via `/repo/../evil.sh`, so fold before comparing.
 */
function canonicalPath(p: string, cwd: string): string {
	let s = p.trim();
	if (s === "~" || s.startsWith("~/")) s = join(homedir(), s.slice(1));
	return resolve(cwd, s).toLowerCase();
}

function isWithin(root: string | undefined, target: string | undefined, cwd: string): boolean {
	if (!root || !target) return false;
	const rootNorm = canonicalPath(root, cwd);
	const targetNorm = canonicalPath(target, cwd);
	// separator-aware containment: root equal or target starts with root + "/" (/repo does not swallow /repo-evil)
	return targetNorm === rootNorm || targetNorm.startsWith(`${rootNorm}/`);
}

function pathsEqual(a: string, b: string, cwd: string): boolean {
	const abs = (p: string): string => {
		const absP = p.startsWith("/") || /^[a-zA-Z]:/.test(p) ? p : join(cwd, p);
		return normalizePath(absP);
	};
	return abs(a) === abs(b);
}

// Default chain: a typed ordered chain where the first non-null decision wins. Order carries the safety contract:
// - user deny at the very front (overrides every mode approval, yolo/auto included);
// - plan/science read-only next (hard, unbypassable in any mode — user ask/allow sit behind them);
// - user ask before mode rules (a forced ask beats auto/yolo approvals);
// - auto before the sensitive ask (auto silently allows, deliberately asymmetric);
// - session approval before mode (explicit user grant wins);
// - sensitive files/.git internals before user allow AND yolo (allow can only skip approval prompts, never
//   bypass a hard ask);
// - writes inside a git work tree auto-approved (recoverable via version control).
//
// Research tools allowed during science mode: they write only Kea's own `.kea` ledger, run read-only
// measurement, or delegate to read-only subagents — none mutate the user's workspace files.
const SCIENCE_TOOLS = new Set([
	"spawn_agent",
	"spawn_swarm",
	"autoresearch_init",
	"autoresearch_step",
	"evaluate_solution",
	"define_evaluator",
	"check_goal",
	"verify_claim",
	"check_novelty",
	"search_literature",
	"query_material",
	"validate_reactions",
	"journal_note",
	"journal_recall",
	"remember",
	"note",
	"recall",
	"log_research_gap",
	"list_research_gaps",
	"log_progress",
	"start_program",
	"update_node",
	"add_nodes",
	"program_note",
	"register_instrument",
	"calibrate_instrument",
	"record_barrier",
	"start_goal",
	"update_goal",
]);

export function defaultPolicyChain(): PolicyRule[] {
	return [
		{
			id: "user-deny",
			decide(req, ctx) {
				const hit = ctx.rules.deny.find((pattern) => permissionRuleMatches(pattern, req));
				return hit === undefined
					? undefined
					: { verdict: "deny", ruleId: "user-deny", reason: `denied by user permission rule "${hit}"` };
			},
		},
		{
			id: "plan-readonly",
			decide(req, ctx) {
				if (!ctx.planMode) return undefined;
				// let the exit tool through to plan-review (ask) — plan mode must be exitable
				if (req.toolName === "exit_plan_mode") return undefined;
				if (
					req.toolName === "enter_plan_mode" ||
					req.toolName === "todo_list" ||
					req.toolName === "fetch_url" ||
					req.toolName === "web_search" ||
					req.toolName === "read_media_file"
				) {
					return { verdict: "approve", ruleId: "plan-readonly" };
				}
				if (req.kind === "read") {
					// sensitive files / .git internals still require approval: plan is the strictest mode, it must not become the loosest
					if (req.path && (isSensitiveFile(req.path) || touchesGitInternals(req.path))) {
						return {
							verdict: "ask",
							ruleId: "plan-sensitive-ask",
							reason: "sensitive access requires approval even in plan mode",
						};
					}
					return { verdict: "approve", ruleId: "plan-readonly" };
				}
				// the plan file is the only writable target (the core constraint of tool-ized planning)
				if (req.kind === "write" && req.path && ctx.planFilePath && pathsEqual(req.path, ctx.planFilePath, ctx.cwd)) {
					return { verdict: "approve", ruleId: "plan-file-write" };
				}
				return { verdict: "deny", ruleId: "plan-readonly", reason: "plan mode is read-only; exit plan mode to modify" };
			},
		},
		{
			id: "science-readonly",
			decide(req, ctx) {
				if (!ctx.scienceMode) return undefined;
				// submit_science_plan falls through to the approval gate (same review semantics as plan submission)
				if (req.toolName === "science_plan" || req.toolName === "submit_science_plan") return undefined;
				if (SCIENCE_TOOLS.has(req.toolName)) return { verdict: "approve", ruleId: "science-readonly" };
				if (
					req.toolName === "enter_plan_mode" ||
					req.toolName === "todo_list" ||
					req.toolName === "fetch_url" ||
					req.toolName === "web_search" ||
					req.toolName === "read_media_file"
				) {
					return { verdict: "approve", ruleId: "science-readonly" };
				}
				if (req.kind === "read") {
					if (req.path && (isSensitiveFile(req.path) || touchesGitInternals(req.path))) {
						return {
							verdict: "ask",
							ruleId: "science-sensitive-ask",
							reason: "sensitive access requires approval even in science mode",
						};
					}
					return { verdict: "approve", ruleId: "science-readonly" };
				}
				return {
					verdict: "deny",
					ruleId: "science-readonly",
					reason: "science mode is read-only; exit science mode to modify",
				};
			},
		},
		{
			id: "plan-review",
			decide(req, ctx) {
				// review gate before yolo: plan submission requires review in non-auto modes
				if (req.toolName !== "exit_plan_mode") return undefined;
				if (ctx.mode === "auto") return undefined;
				return { verdict: "ask", ruleId: "plan-review", reason: "plan submission requires review" };
			},
		},
		{
			id: "user-ask",
			decide(req, ctx) {
				const hit = ctx.rules.ask.find((pattern) => permissionRuleMatches(pattern, req));
				return hit === undefined
					? undefined
					: { verdict: "ask", ruleId: "user-ask", reason: `user permission rule "${hit}" requires approval` };
			},
		},
		{
			id: "mode-auto",
			decide(_req, ctx) {
				// auto is fully autonomous, no more questions — the sensitive ask does not apply (deliberately asymmetric with yolo)
				return ctx.mode === "auto" ? { verdict: "approve", ruleId: "mode-auto" } : undefined;
			},
		},
		{
			id: "session-approval",
			decide(req, ctx) {
				return ctx.approvals.matches(req) ? { verdict: "approve", ruleId: "session-approval" } : undefined;
			},
		},
		{
			id: "sensitive-file-ask",
			decide(req, ctx) {
				if (ctx.mode !== "yolo" && ctx.mode !== "manual") return undefined;
				if (req.kind !== "read" && req.kind !== "write") return undefined;
				const p = req.path;
				if (!p) return undefined;
				if (isSensitiveFile(p)) {
					return { verdict: "ask", ruleId: "sensitive-file-ask", reason: "sensitive file access requires approval" };
				}
				if (touchesGitInternals(p)) {
					return {
						verdict: "ask",
						ruleId: "git-internal-ask",
						reason: "direct access to git internals requires approval",
					};
				}
				return undefined;
			},
		},
		{
			id: "user-allow",
			decide(req, ctx) {
				const hit = ctx.rules.allow.find((pattern) => permissionRuleMatches(pattern, req));
				return hit === undefined ? undefined : { verdict: "approve", ruleId: "user-allow" };
			},
		},
		{
			id: "mode-yolo",
			decide(_req, ctx) {
				return ctx.mode === "yolo" ? { verdict: "approve", ruleId: "mode-yolo" } : undefined;
			},
		},
		{
			id: "reads-free",
			decide(req) {
				return req.kind === "read" ? { verdict: "approve", ruleId: "reads-free" } : undefined;
			},
		},
		{
			id: "web-readonly-approve",
			decide(req) {
				// web tools are read-only network operations: allow by default at the same tier as reads-free (deny rules can still override)
				return req.toolName === "fetch_url" || req.toolName === "web_search"
					? { verdict: "approve", ruleId: "web-readonly-approve" }
					: undefined;
			},
		},
		{
			id: "git-worktree-write",
			decide(req, ctx) {
				if (req.kind !== "write") return undefined;
				if (!isWithin(ctx.gitRoot, req.path, ctx.cwd)) return undefined;
				return { verdict: "approve", ruleId: "git-worktree-write" };
			},
		},
		{
			id: "fallback-ask",
			decide(req) {
				return { verdict: "ask", ruleId: "fallback-ask", reason: `${req.kind} operation needs approval` };
			},
		},
	];
}

export interface PolicyEngineOptions {
	mode?: PermissionMode;
	cwd: string;
	/** Override git detection (tests and special scenarios) */
	gitRoot?: string | undefined;
	approvals?: SessionApprovals;
	chain?: PolicyRule[];
	// Inject user permission rules directly (tests). Default: load `<cwd>/kea.toml` [permission] synchronously
	// at construction — the engine is built synchronously in the kernel. trusted:false skips project-level rules
	// (same trust gate as execpolicy/MCP).
	rules?: UserPermissionRules;
	trusted?: boolean;
}

// Permission engine: typed policy chain + request-identity session approvals. Chain order is the contract
// (see defaultPolicyChain comments); evaluate is a pure decision, approval interaction lives in the kernel gate layer.
export class PolicyEngine {
	private mode: PermissionMode;
	private planMode: boolean;
	private scienceMode: boolean;
	private readonly cwd: string;
	private readonly gitRoot: string | undefined;
	readonly approvals: SessionApprovals;
	private readonly chain: PolicyRule[];
	private planFilePath: string | undefined;
	private userRules: UserPermissionRules;

	constructor(options: PolicyEngineOptions) {
		this.mode = options.mode ?? "manual";
		this.planMode = false;
		this.scienceMode = false;
		this.cwd = options.cwd;
		this.gitRoot = options.gitRoot !== undefined ? options.gitRoot : findGitRoot(options.cwd);
		this.approvals = options.approvals ?? new SessionApprovals();
		this.chain = options.chain ?? defaultPolicyChain();
		this.userRules =
			options.rules ??
			(options.trusted === false ? { ...EMPTY_USER_PERMISSION_RULES } : loadPermissionRules(options.cwd));
	}

	/** Re-read kea.toml [permission] (kernel reloadPolicy wiring); injected rules cannot be reloaded */
	reloadUserRules(): void {
		this.userRules = loadPermissionRules(this.cwd);
	}

	get currentMode(): PermissionMode {
		return this.mode;
	}

	get currentPlanMode(): boolean {
		return this.planMode;
	}

	get currentScienceMode(): boolean {
		return this.scienceMode;
	}

	setMode(mode: PermissionMode): void {
		this.mode = mode;
	}

	/** plan and science modes are mutually exclusive: entering one leaves the other */
	setPlanMode(on: boolean): void {
		this.planMode = on;
		if (on) this.scienceMode = false;
	}

	setScienceMode(on: boolean): void {
		this.scienceMode = on;
		if (on) this.planMode = false;
	}

	setPlanFilePath(path: string | undefined): void {
		this.planFilePath = path;
	}

	evaluate(req: ToolRequest): PolicyDecision {
		const ctx: PolicyContext = {
			mode: this.mode,
			planMode: this.planMode,
			scienceMode: this.scienceMode,
			cwd: this.cwd,
			gitRoot: this.gitRoot,
			approvals: this.approvals,
			planFilePath: this.planFilePath,
			rules: this.userRules,
		};
		for (const rule of this.chain) {
			const decision = rule.decide(req, ctx);
			if (decision) return decision;
		}
		return { verdict: "ask", ruleId: "fallback-ask", reason: "no policy matched; asking the user" };
	}
}

export interface CommandRule {
	id: string;
	pattern: RegExp;
	reason: string;
}

// Static review is advisory-only and never blocks: one warn bucket, no severity tiers.
export const BUILTIN_COMMAND_RULES: readonly CommandRule[] = [
	{
		id: "rm-root",
		// recursive rm aimed at bare `/`, `$HOME` itself, or anything under it (`rm -rf ~/projects` must warn;
		// routine `/tmp/x` style paths do not match)
		pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:\/(?![^\s/])|~(?:\/[^\s]*|\s|$)|\$HOME(?:\/[^\s]*|\s|$))/,
		reason: "recursive delete of a root/home path",
	},
	{
		id: "rm-wildcard",
		pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\*\s*$/,
		reason: "recursive delete via bare wildcard",
	},
	{ id: "sudo", pattern: /\bsudo\b/, reason: "privilege escalation (sudo) is not allowed" },
	{
		id: "curl-pipe-shell",
		pattern: /\b(curl|wget)\b[^\n|]*\|\s*(ba)?sh\b/,
		reason: "piping a remote download directly into a shell",
	},
	{ id: "disk-write", pattern: /\bmkfs\b|\bdd\s+[^;&|]*of=\/dev\//, reason: "low-level disk writes" },
	{
		id: "chmod-root",
		pattern: /\bchmod\s+(-R\s+)?777\s+(\/|~|\$HOME)/,
		reason: "world-writable permissions on root/home",
	},
	{ id: "kill-init", pattern: /\bkill\s+(-9\s+)?1\b/, reason: "killing init (pid 1)" },
	{
		id: "block-device",
		pattern: />\s*\/dev\/(sd[a-z]|nvme|disk)/,
		reason: "raw writes to block devices",
	},
	{ id: "fork-bomb", pattern: /:(\(\)\s*\{.*\|.*&\s*\}\s*;?\s*:)/, reason: "fork-bomb pattern" },
	{
		id: "pip-install",
		pattern: /\bpip(3)?\s+install\b/,
		reason: "installs packages (network + environment mutation)",
	},
	{
		id: "download-to-disk",
		pattern: /\b(curl|wget)\b[^\n|]*(-o|>|>>)/,
		reason: "downloads remote content to disk",
	},
	{ id: "git-push", pattern: /\bgit\s+push\b/, reason: "pushes to a remote repository" },
	{
		id: "git-force-push",
		pattern: /\bgit\s+push\b[^\n|]*(--force|-f)\b/,
		reason: "force push rewrites remote history",
	},
	{
		id: "git-internal",
		pattern: /(^|[\s'"`(])([^\s'"`]*\/)?\.git\//,
		reason: "directly touches git internals",
	},
	{
		id: "npm-global",
		pattern: /\bnpm\s+(publish|install\s+-g)\b/,
		reason: "publishes/installs global packages",
	},
];

export interface ExecPolicy {
	warn: RegExp[];
}

export interface PolicyVerdict {
	verdict: "allow" | "warn";
	ruleId?: string;
	reason?: string;
}

export function policyFilePath(cwd: string): string {
	return join(cwd, ".kea", "execpolicy.json");
}

const ExecPolicyFileSchema = z.object({
	// `deny` is accepted from older config files but folded into warn — severity never had behavioral effect
	deny: z.array(z.string()).optional(),
	warn: z.array(z.string()).optional(),
});

export async function loadExecPolicy(cwd: string): Promise<ExecPolicy> {
	const warn: RegExp[] = [];
	const file = Bun.file(policyFilePath(cwd));
	if (await file.exists()) {
		try {
			const parsed = ExecPolicyFileSchema.safeParse(await file.json());
			if (parsed.success) {
				for (const src of [...(parsed.data.deny ?? []), ...(parsed.data.warn ?? [])]) {
					try {
						warn.push(new RegExp(src));
					} catch {} // invalid regex skips this entry (advisory policy does not fail on one bad rule)
				}
			}
		} catch {}
	}
	return { warn };
}

export function splitSegments(command: string): string[] {
	return command
		.split(/\n|&&|\|\||;|\||\$\(|`/)
		.map((s) => s.trim())
		.filter((s) => s !== "");
}

/** Static review is advisory (never blocks; every hit is a warn hint; blocking is decided by the approval mode). */
export function reviewCommand(command: string, policy: ExecPolicy): PolicyVerdict {
	const haystacks = [command, ...splitSegments(command)];
	let warn: PolicyVerdict | undefined;

	for (const rule of BUILTIN_COMMAND_RULES) {
		for (const text of haystacks) {
			if (!rule.pattern.test(text)) continue;
			warn ??= { verdict: "warn", ruleId: rule.id, reason: rule.reason };
		}
	}
	for (const pattern of policy.warn) {
		if (haystacks.some((text) => pattern.test(text))) {
			warn ??= { verdict: "warn", ruleId: "project-policy", reason: `project policy: ${pattern.source}` };
		}
	}
	return warn ?? { verdict: "allow" };
}

/** Dangerous-command hint text (used for the approval panel's danger badge). */
export function execpolicyWarning(command: string, policy: ExecPolicy): string | undefined {
	const verdict = reviewCommand(command, policy);
	return verdict.verdict === "warn" ? verdict.reason : undefined;
}
