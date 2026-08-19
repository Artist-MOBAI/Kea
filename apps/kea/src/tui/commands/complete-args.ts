import type { AutocompleteItem } from "@earendil-works/pi-tui";

export function completeLeadingArg(specs: readonly string[], prefix: string): AutocompleteItem[] | null {
	if (prefix.includes(" ")) return null;
	const lower = prefix.toLowerCase();
	const matches = specs.filter((s) => s.toLowerCase().startsWith(lower));
	if (matches.length === 0) return null;
	if (matches.length === 1 && matches[0]?.toLowerCase() === lower) return null;
	return matches.map((value) => ({ value, label: value }));
}
