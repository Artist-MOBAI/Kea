import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { printableKey } from "../src/tui/utils/printable-key.ts";

describe("printableKey (Kitty keyboard protocol printable-key decoding)", () => {
	test("CSI-u sequences decode to the corresponding character", () => {
		expect(printableKey("\x1b[113u")).toBe("q");
		expect(printableKey("\x1b[49u")).toBe("1");
		expect(printableKey("\x1b[32u")).toBe(" ");
	});

	test("plain characters and function-key sequences pass through unchanged", () => {
		expect(printableKey("q")).toBe("q");
		expect(printableKey("Q")).toBe("Q");
		expect(printableKey("\x1b")).toBe("\x1b");
		expect(printableKey("\x1b[A")).toBe("\x1b[A");
	});
});

describe("printable-key guard (regression prevention)", () => {
	function collectTs(dir: string, out: string[] = []): string[] {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) collectTs(full, out);
			else if (entry.name.endsWith(".ts")) out.push(full);
		}
		return out;
	}

	test("tui sources no longer compare bare data === against a single printable char (broken under Kitty)", () => {
		const root = fileURLToPath(new URL("../src/tui", import.meta.url));
		const files = collectTs(root);
		const forbidden = /data\s*===\s*"[a-zA-Z0-9 ]"/g;
		const hits: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, "utf-8");
			if (forbidden.test(text)) {
				forbidden.lastIndex = 0;
				for (const line of text.split("\n")) {
					if (forbidden.test(line)) {
						forbidden.lastIndex = 0;
						hits.push(`${file}: ${line.trim()}`);
					}
				}
			}
		}
		expect(hits, "decode with printableKey(data) before comparing").toEqual([]);
	});
});
