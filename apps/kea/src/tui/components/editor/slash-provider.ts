import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	fuzzyMatch,
} from "@earendil-works/pi-tui";
import { sortCommands } from "../../commands/registry.ts";
import type { KeaSlashCommand } from "../../commands/types.ts";

interface CommandMatch {
	readonly score: number;
	readonly viaAlias: boolean;
}

export class SlashAwareAutocomplete implements AutocompleteProvider {
	triggerCharacters = ["/", "@"];
	private readonly commands: readonly KeaSlashCommand[];
	private readonly fallback: CombinedAutocompleteProvider;

	constructor(commands: readonly KeaSlashCommand[], basePath: string, fdPath?: string | null) {
		this.commands = sortCommands(commands);
		this.fallback = new CombinedAutocompleteProvider([], basePath, fdPath ?? null);
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const text = (lines[cursorLine] ?? "").slice(0, cursorCol);
		if (!text.startsWith("/")) return this.fallback.getSuggestions(lines, cursorLine, cursorCol, options);
		if (cursorLine !== 0 || options.force) return null;
		const spaceIdx = text.indexOf(" ");
		if (spaceIdx === -1) {
			const prefix = text.slice(1).toLowerCase();
			const ranked = this.commands
				.map((c) => ({ c, m: this.matchCommand(c, prefix) }))
				.filter((r): r is { c: KeaSlashCommand; m: CommandMatch } => r.m !== undefined)
				.sort((a, b) => a.m.score - b.m.score);
			if (ranked.length === 0) return null;
			const items: AutocompleteItem[] = ranked.map(({ c, m }) => ({
				value: c.name,
				label: m.viaAlias ? `${c.name} (${(c.aliases as readonly string[]).join(", ")})` : c.name,
				description: `${c.argumentHint ? `${c.argumentHint} — ` : ""}${c.description}`,
			}));
			return { items, prefix: text };
		}

		const nameOrAlias = text.slice(1, spaceIdx).toLowerCase();
		const cmd = this.commands.find(
			(c) => c.name === nameOrAlias || (c.aliases as readonly string[]).includes(nameOrAlias),
		);
		if (!cmd?.completeArgs) return null;
		const argText = text.slice(spaceIdx + 1);
		const items = await cmd.completeArgs(argText);
		if (!Array.isArray(items) || items.length === 0) return null;
		return { items, prefix: argText };
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		return this.fallback.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] ?? "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		// Only slash command names (`/` prefix at line start, not a path) insert here; @ files and
		// command-argument completion delegate to fallback (preserving the @ form and quote handling).
		const isSlashName = prefix.startsWith("/") && beforePrefix.trim() === "" && !prefix.slice(1).includes("/");
		if (!isSlashName) return this.fallback.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		const afterCursor = currentLine.slice(cursorCol);
		const newLines = [...lines];
		newLines[cursorLine] = `${beforePrefix}/${item.value} ${afterCursor}`;
		return { lines: newLines, cursorLine, cursorCol: beforePrefix.length + item.value.length + 2 };
	}

	private matchCommand(c: KeaSlashCommand, prefix: string): CommandMatch | undefined {
		if (prefix === "") return { score: 0, viaAlias: false };
		const primary = fuzzyMatch(prefix, c.name);
		if (primary.matches) return { score: primary.score, viaAlias: false };
		let best: number | undefined;
		for (const alias of c.aliases as readonly string[]) {
			const m = fuzzyMatch(prefix, alias);
			if (m.matches && (best === undefined || m.score < best)) best = m.score + 50;
		}
		return best === undefined ? undefined : { score: best, viaAlias: true };
	}
}
