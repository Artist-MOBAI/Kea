import { parseSlashInput } from "./parse.ts";
import { BUILTIN_COMMANDS, findBuiltinCommand, suggestCommand } from "./registry.ts";
import type { CommandIntent, KeaSlashCommand, SlashCommandBusyReason } from "./types.ts";

export function resolveSlashCommandInput(input: string, busy: SlashCommandBusyReason | undefined): CommandIntent {
	const parsed = parseSlashInput(input);
	if (!parsed) return { kind: "not-command" };

	const command = findBuiltinCommand(parsed.name);
	if (!command) {
		const suggestion = suggestCommand(parsed.name, BUILTIN_COMMANDS as readonly KeaSlashCommand[]);
		return { kind: "invalid", commandName: parsed.name, suggestion };
	}

	const availability =
		typeof command.availability === "function"
			? command.availability(parsed.args)
			: (command.availability ?? "idle-only");
	if (availability === "idle-only" && busy) {
		return { kind: "blocked", commandName: command.name, reason: busy };
	}

	return { kind: "builtin", command, name: command.name, args: parsed.args };
}
