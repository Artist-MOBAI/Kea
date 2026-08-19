import { completeLeadingArg } from "./complete-args.ts";
import type { KeaSlashCommand } from "./types.ts";

export const BUILTIN_COMMANDS = [
	{
		name: "yolo",
		aliases: ["yes"],
		description: "Auto-approve tools (may still ask); toggle again to return to manual",
		argumentHint: "[on|off]",
		priority: 101,
		availability: "always",
		completeArgs: (prefix: string) => completeLeadingArg(["on", "off"], prefix),
	},
	{
		name: "model",
		aliases: [],
		description:
			"Switch model (no args opens the picker); /model add adds a custom endpoint; known providers via /provider",
		argumentHint: "[provider/model-id | add]",
		priority: 100,
		// add uses a multi-step wizard and is rejected while streaming; no-arg/direct switch stays always (the picker judges streaming internally).
		availability: (args: string) => (args.toLowerCase() === "add" ? "idle-only" : "always"),
		completeArgs: (prefix: string) =>
			prefix === "" || "add".startsWith(prefix.toLowerCase())
				? [{ value: "add", label: "add", description: "Add a custom endpoint (known providers: /provider → Add)" }]
				: null,
	},
	{
		name: "permission",
		aliases: [],
		description: "Permission mode picker (no args opens it; Shift+Tab cycles)",
		argumentHint: "[manual|auto|yolo]",
		priority: 100,
		availability: "always",
		completeArgs: (prefix: string) => completeLeadingArg(["manual", "auto", "yolo"], prefix),
	},
	{
		name: "plan",
		aliases: [],
		description: "Plan mode (read-only enforced) toggle/on/off; clear empties the plan file and stays in plan mode",
		argumentHint: "[on|off|clear]",
		priority: 100,
		availability: "always",
		completeArgs: (prefix: string) => completeLeadingArg(["on", "off", "clear"], prefix),
	},
	{
		name: "provider",
		aliases: [],
		description: "Manage providers & credentials (API keys for known providers, custom endpoints)",
		priority: 100,
		availability: "always",
	},
	{
		name: "settings",
		aliases: ["config"],
		description: "Settings menu (model/permission/effort); direct key=value not yet supported",
		priority: 100,
		availability: "always",
	},
	{
		name: "auto",
		aliases: [],
		description: "Fully autonomous mode; toggle again to return to manual",
		argumentHint: "[on|off]",
		priority: 99,
		availability: "always",
		completeArgs: (prefix: string) => completeLeadingArg(["on", "off"], prefix),
	},
	{
		name: "effort",
		aliases: ["thinking"],
		description: "Thinking level",
		argumentHint: "[off|minimal|low|medium|high]",
		priority: 95,
		availability: "always",
		completeArgs: (prefix: string) => completeLeadingArg(["off", "minimal", "low", "medium", "high"], prefix),
	},
	{
		name: "compact",
		aliases: [],
		description: "Compact the conversation context (optional custom instruction)",
		argumentHint: "<instruction>",
		priority: 80,
		availability: "idle-only",
	},
	{
		name: "fork",
		aliases: [],
		description: "Start a new session from a copy of the current conversation",
		priority: 80,
		availability: "idle-only",
	},
	{
		name: "mobai",
		aliases: [],
		description:
			"Start or manage the machine-verifiable mobai (/mobai <objective> starts; status/check/pause/resume/cancel/replace/next)",
		argumentHint: "[status|check|clear|pause|resume|cancel|replace|next] | <objective>",
		priority: 80,
		// resume ignites a round via kernel.prompt — mid-stream it would throw "run in progress";
		// pause/cancel/replace stay always-available by design (they must intercept a live loop).
		availability: (args: string) => (args.trim().toLowerCase().startsWith("resume") ? "idle-only" : "always"),
		completeArgs: (prefix: string) => {
			if (prefix.toLowerCase().startsWith("next ")) {
				return completeLeadingArg(["list", "remove", "clear"], prefix.slice(5));
			}
			return completeLeadingArg(["status", "check", "clear", "pause", "resume", "cancel", "replace", "next"], prefix);
		},
	},
	{
		name: "help",
		aliases: ["h", "?"],
		description: "Commands & keybindings",
		priority: 80,
		availability: "always",
	},
	{
		name: "new",
		aliases: ["clear"],
		description: "Start a new session",
		priority: 80,
		availability: "idle-only",
	},
	{
		name: "sessions",
		aliases: ["resume"],
		description: "Session history picker (selecting switches and replays the transcript)",
		priority: 80,
		availability: "idle-only",
	},
	{
		name: "tasks",
		aliases: [],
		description: "Experiment tasks panel: status/backend/elapsed for all jobs",
		priority: 80,
		availability: "always",
	},
	{
		name: "undo",
		aliases: [],
		description: "Roll back the last n conversation turns in memory (the append-only ledger is unaffected)",
		argumentHint: "[n]",
		priority: 80,
		availability: "idle-only",
	},
	{
		name: "doctor",
		aliases: [],
		description: "Environment doctor (credentials/Python/MCP/backends)",
		priority: 60,
		availability: "always",
	},
	{
		name: "mcp",
		aliases: [],
		description: "MCP server connection status",
		priority: 60,
		availability: "always",
	},
	{
		name: "reload",
		aliases: [],
		description: "Reload execpolicy and other config",
		priority: 60,
		availability: "idle-only",
	},
	{
		name: "status",
		aliases: [],
		description: "Runtime status",
		priority: 60,
		availability: "always",
	},
	{
		name: "title",
		aliases: ["rename"],
		description: "Set the session title",
		argumentHint: "<title>",
		priority: 60,
		availability: "always",
	},
	{
		name: "usage",
		aliases: ["cost"],
		description: "Token/cost/budget usage",
		priority: 60,
		availability: "always",
	},
	{
		name: "context",
		aliases: [],
		description: "Context usage details",
		priority: 50,
		availability: "always",
	},
	{
		name: "copy",
		aliases: [],
		description: "Copy the last reply (OSC 52)",
		priority: 40,
	},
	{
		name: "export-debug-zip",
		aliases: [],
		description: "Export a debug bundle (doctor/status/job ledger/journal stats, no secrets or session content)",
		priority: 40,
	},
	{
		name: "export-md",
		aliases: ["export"],
		description: "Export the current session as a Markdown file (optional output path)",
		argumentHint: "[path]",
		priority: 40,
	},
	{
		name: "exit",
		aliases: ["quit", "q"],
		description: "Exit",
		priority: 20,
		availability: "always",
	},
	{
		name: "version",
		aliases: [],
		description: "Version info",
		priority: 20,
		availability: "always",
	},
] as const satisfies readonly KeaSlashCommand[];

export function findBuiltinCommand(name: string): KeaSlashCommand | undefined {
	const lower = name.toLowerCase();
	return BUILTIN_COMMANDS.find((c) => c.name === lower || (c.aliases as readonly string[]).includes(lower)) as
		| KeaSlashCommand
		| undefined;
}

export function sortCommands(commands: readonly KeaSlashCommand[]): KeaSlashCommand[] {
	return [...commands].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name));
}

export function suggestCommand(name: string, commands: readonly KeaSlashCommand[]): string | undefined {
	const lower = name.toLowerCase();
	let best: { cmd: string; dist: number } | undefined;
	for (const c of commands) {
		for (const candidate of [c.name, ...(c.aliases as readonly string[])]) {
			const dist = levenshtein(lower, candidate);
			if (dist <= 2 && (!best || dist < best.dist)) best = { cmd: c.name, dist };
		}
	}
	return best?.cmd;
}

function levenshtein(a: string, b: string): number {
	const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = dp[0] ?? 0;
		dp[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = dp[j] ?? 0;
			dp[j] = Math.min((dp[j] ?? 0) + 1, (dp[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return dp[b.length] ?? Number.POSITIVE_INFINITY;
}
