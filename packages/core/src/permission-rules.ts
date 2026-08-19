import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isEnoent } from "./errors.ts";

/** User-configured permission rules from `<cwd>/kea.toml` `[permission]` (allow/ask/deny pattern arrays). */
export interface UserPermissionRules {
	allow: string[];
	ask: string[];
	deny: string[];
}

export const EMPTY_USER_PERMISSION_RULES: UserPermissionRules = { allow: [], ask: [], deny: [] };

export interface PermissionRuleTarget {
	toolName: string;
	args?: unknown;
	command?: string;
}

export interface ParsedPermissionPattern {
	toolName: string;
	argPattern?: string;
}

/**
 * Parse a rule pattern: `Tool` (tool-name glob, `*` wildcard) or `Tool(argSubstring)`.
 * Tool name and arg substring are trimmed after slicing (`"Bash (npm install)"` must match the `bash` tool,
 * not a tool literally named `"Bash "`); surrounding whitespace in the original warns but stays fail-open.
 * Returns undefined for malformed patterns (the entry is skipped — one bad rule must not brick the chain).
 */
export function parsePermissionPattern(pattern: string): ParsedPermissionPattern | undefined {
	const trimmed = pattern.trim();
	if (trimmed === "") return undefined;
	const open = trimmed.indexOf("(");
	if (open === -1) return { toolName: trimmed };
	if (!trimmed.endsWith(")")) return undefined;
	const rawToolName = trimmed.slice(0, open);
	const rawArgPattern = trimmed.slice(open + 1, -1);
	const toolName = rawToolName.trim();
	const argPattern = rawArgPattern.trim();
	if (rawToolName !== toolName || rawArgPattern !== argPattern) {
		console.warn(`[permission] rule "${pattern}" has surrounding whitespace inside the pattern; trimmed to match`);
	}
	if (toolName === "") return undefined;
	if (argPattern === "") return { toolName }; // "Tool()" is a tool-name-only rule
	return { toolName, argPattern };
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Tool-name glob with `*` as the only wildcard; case-insensitive (config ergonomics: "Bash" matches the `bash` tool). */
function toolNameMatches(pattern: string, toolName: string): boolean {
	if (pattern === "*") return true;
	const re = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`, "i");
	return re.test(toolName);
}

/**
 * Match one rule pattern against a request:
 * - tool-name glob must hit first (`*` matches everything);
 * - arg substring (case-insensitive literal contains, not a glob): the bash command for bash,
 *   JSON-stringified args for every other tool.
 */
export function permissionRuleMatches(pattern: string, target: PermissionRuleTarget): boolean {
	const parsed = parsePermissionPattern(pattern);
	if (parsed === undefined) return false;
	if (!toolNameMatches(parsed.toolName, target.toolName)) return false;
	if (parsed.argPattern === undefined) return true;
	const needle = parsed.argPattern.toLowerCase();
	if (target.toolName === "bash") {
		return (target.command ?? "").toLowerCase().includes(needle);
	}
	let argsText: string;
	try {
		argsText = JSON.stringify(target.args ?? {}) ?? "";
	} catch {
		argsText = "";
	}
	return argsText.toLowerCase().includes(needle);
}

export function permissionRulesPath(cwd: string): string {
	return join(cwd, "kea.toml");
}

function warnIgnored(path: string, why: string): void {
	console.warn(`[permission] ignoring ${path}: ${why}`);
}

/**
 * Load `[permission]` from `<cwd>/kea.toml` (native Bun.TOML parse).
 * Missing/bad file → warn + empty rules (fail-open: rules only tighten, their absence must not brick the engine).
 */
export function loadPermissionRules(cwd: string): UserPermissionRules {
	const path = permissionRulesPath(cwd);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if (isEnoent(err)) return { ...EMPTY_USER_PERMISSION_RULES };
		warnIgnored(path, `unreadable (${err instanceof Error ? err.message : String(err)})`);
		return { ...EMPTY_USER_PERMISSION_RULES };
	}
	try {
		const parsed = Bun.TOML.parse(text) as unknown;
		if (typeof parsed !== "object" || parsed === null) {
			warnIgnored(path, "top-level value is not a table");
			return { ...EMPTY_USER_PERMISSION_RULES };
		}
		const table = (parsed as Record<string, unknown>).permission;
		if (table === undefined) return { ...EMPTY_USER_PERMISSION_RULES };
		if (typeof table !== "object" || table === null || Array.isArray(table)) {
			warnIgnored(path, "[permission] is not a TOML table");
			return { ...EMPTY_USER_PERMISSION_RULES };
		}
		const strings = (key: string): string[] => {
			const value = (table as Record<string, unknown>)[key];
			if (!Array.isArray(value)) return [];
			return value.filter((entry): entry is string => typeof entry === "string");
		};
		return { allow: strings("allow"), ask: strings("ask"), deny: strings("deny") };
	} catch (err) {
		warnIgnored(path, `invalid TOML (${err instanceof Error ? err.message : String(err)})`);
		return { ...EMPTY_USER_PERMISSION_RULES };
	}
}
