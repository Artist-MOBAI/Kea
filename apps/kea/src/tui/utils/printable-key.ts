import { decodeKittyPrintable } from "@earendil-works/pi-tui";

// Under Kitty keyboard protocol flag 1, ordinary letters/digits/space arrive as CSI-u sequences
// (e.g. q → \x1b[113u), so raw comparison breaks in Kitty/Iterm2/WezTerm/Ghostty. Decode before
// comparing; matchesKey already covers function/modifier keys.
export function printableKey(data: string): string {
	return decodeKittyPrintable(data) ?? data;
}
