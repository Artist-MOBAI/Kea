import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
	EMPTY_USER_PERMISSION_RULES,
	loadPermissionRules,
	parsePermissionPattern,
	permissionRuleMatches,
} from "../src/permission-rules.ts";

const tempDirs: string[] = [];

afterAll(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function rulesWorkdir(toml?: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "kea2-perm-rules-"));
	if (toml !== undefined) await Bun.write(join(root, "kea.toml"), toml);
	tempDirs.push(root);
	return root;
}

describe("rule DSL: parsePermissionPattern", () => {
	test("bare tool name, with args, empty args, wildcard", () => {
		expect(parsePermissionPattern("Bash")).toEqual({ toolName: "Bash" });
		expect(parsePermissionPattern("Bash(rm -rf *)")).toEqual({ toolName: "Bash", argPattern: "rm -rf *" });
		expect(parsePermissionPattern("Bash()")).toEqual({ toolName: "Bash" });
		expect(parsePermissionPattern("*")).toEqual({ toolName: "*" });
	});

	test("malformed → undefined (entry skipped, does not break the chain)", () => {
		expect(parsePermissionPattern("")).toBeUndefined();
		expect(parsePermissionPattern("   ")).toBeUndefined();
		expect(parsePermissionPattern("Bash(rm")).toBeUndefined(); // missing closing paren
		expect(parsePermissionPattern("(x)")).toBeUndefined(); // empty tool name
	});

	test("G9: trims in-pattern whitespace after slicing ('Bash (npm install)' must match bash) and warns", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// the trailing space used to make toolName "Bash " — a name no tool ever has, the rule silently never matched
			expect(parsePermissionPattern("Bash (npm install)")).toEqual({ toolName: "Bash", argPattern: "npm install" });
			expect(permissionRuleMatches("Bash (npm install)", { toolName: "bash", command: "npm install -g x" })).toBe(true);
			// warn per parse (parsePermissionPattern and permissionRuleMatches both re-parse)
			expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("Bash (npm install)"))).toBe(true);

			// leading/trailing whitespace inside the parens is trimmed too (needle substring match stays meaningful)
			expect(parsePermissionPattern("Bash(  npm install  )")).toEqual({ toolName: "Bash", argPattern: "npm install" });

			// clean patterns do not warn
			warnSpy.mockClear();
			expect(parsePermissionPattern("Bash(rm -rf *)")).toEqual({ toolName: "Bash", argPattern: "rm -rf *" });
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe("rule DSL: permissionRuleMatches", () => {
	test("tool-name glob is case-insensitive (config Bash matches the bash tool)", () => {
		expect(permissionRuleMatches("Bash", { toolName: "bash" })).toBe(true);
		expect(permissionRuleMatches("Read", { toolName: "read" })).toBe(true);
		expect(permissionRuleMatches("Bash", { toolName: "write" })).toBe(false);
	});

	test("* and prefix wildcards", () => {
		expect(permissionRuleMatches("*", { toolName: "anything" })).toBe(true);
		expect(permissionRuleMatches("mcp__srv__*", { toolName: "mcp__srv__search" })).toBe(true);
		expect(permissionRuleMatches("mcp__srv__*", { toolName: "mcp__other__search" })).toBe(false);
	});

	test("bash arg substring: command containment (case-insensitive), non-commands never match", () => {
		expect(permissionRuleMatches("Bash(rm -rf *)", { toolName: "bash", command: "cd /tmp && rm -rf *" })).toBe(true);
		expect(permissionRuleMatches("Bash(RM -RF)", { toolName: "bash", command: "rm -rf /tmp/x" })).toBe(true);
		expect(permissionRuleMatches("Bash(rm -rf *)", { toolName: "bash", command: "ls" })).toBe(false);
	});

	test("non-bash tools: args are JSON-serialized then substring-matched", () => {
		expect(permissionRuleMatches("Write(dist)", { toolName: "write", args: { path: "dist/out.js" } })).toBe(true);
		expect(permissionRuleMatches("Write(.env)", { toolName: "write", args: { path: "src/x.ts" } })).toBe(false);
		// no-arg requests match against {} (does not crash)
		expect(permissionRuleMatches("Todo(x)", { toolName: "todo_list" })).toBe(false);
	});

	test("bare tool-name rules ignore args (arg-carrying requests still match)", () => {
		expect(permissionRuleMatches("Bash", { toolName: "bash", command: "anything" })).toBe(true);
	});

	test("malformed rules never match", () => {
		expect(permissionRuleMatches("Bash(rm", { toolName: "bash", command: "rm -rf *" })).toBe(false);
	});
});

describe("loadPermissionRules (kea.toml [permission])", () => {
	test("no kea.toml → empty rules", async () => {
		const root = await rulesWorkdir();
		expect(loadPermissionRules(root)).toEqual(EMPTY_USER_PERMISSION_RULES);
	});

	test("valid table: three arrays parsed; non-strings filtered; missing groups default empty", async () => {
		const root = await rulesWorkdir(`[permission]
deny = ["Bash(rm -rf *)"]
ask = ["Bash"]
allow = ["Read", 42, "mcp__srv__*"]
`);
		const rules = loadPermissionRules(root);
		expect(rules).toEqual({
			deny: ["Bash(rm -rf *)"],
			ask: ["Bash"],
			allow: ["Read", "mcp__srv__*"],
		});
	});

	test("kea.toml without a [permission] table → empty rules", async () => {
		const root = await rulesWorkdir(`[other]\nkey = 1\n`);
		expect(loadPermissionRules(root)).toEqual(EMPTY_USER_PERMISSION_RULES);
	});

	test("bad TOML → console.warn + empty rules (fail-open)", async () => {
		const root = await rulesWorkdir(`[permission\ndeny = oops`);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(loadPermissionRules(root)).toEqual(EMPTY_USER_PERMISSION_RULES);
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("[permission] not a table → warn + empty rules", async () => {
		const root = await rulesWorkdir(`[permission]\n`);
		// `[permission]` alone IS a table; use an inline non-table value via dotted key
		const root2 = await rulesWorkdir(`permission = "nope"\n`);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(loadPermissionRules(root)).toEqual({ allow: [], ask: [], deny: [] });
			expect(loadPermissionRules(root2)).toEqual(EMPTY_USER_PERMISSION_RULES);
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
