import type { ParsedSlashInput } from "./types.ts";

export function parseSlashInput(input: string): ParsedSlashInput | undefined {
	// Only spaces/tabs are stripped: a draft whose first line is blank (Ctrl+J) must not have its
	// later-line "/cmd" promoted into a command — slash dispatch and slash completion both mean line 0.
	const trimmed = input.replace(/^[ \t]+/, "");
	if (!trimmed.startsWith("/")) return undefined;
	const spaceIdx = trimmed.indexOf(" ");
	const rawName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
	// Trim trailing spaces too: `/model add ` must resolve to args === "add" (no command depends on a trailing space).
	const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
	const name = rawName.slice(1);
	if (name.includes("/") && !name.includes(":")) return undefined;
	return { name, args };
}
