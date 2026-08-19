import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Project-code English-only guard: src and test trees (plus the root scratch demo) must contain no
// Han characters. The single sanctioned exception is genuine CJK test data, opted in per file with
// a `cjk-fixture:` marker comment on the line above the fixture. Documentation trees are out of
// scope by decision (2026-08-19): only code and its comments/titles are English-mandated.
const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCAN_ROOTS = [
	join(ROOT, "apps", "kea", "src"),
	join(ROOT, "apps", "kea", "tests"),
	join(ROOT, "packages", "core", "src"),
	join(ROOT, "packages", "core", "tests"),
	join(ROOT, "packages", "research", "src"),
	join(ROOT, "packages", "research", "tests"),
	...["domain-chemistry", "domain-literature", "domain-materials"].map((p) => join(ROOT, "packages", p, "src")),
	...["domain-chemistry", "domain-literature", "domain-materials"].map((p) => join(ROOT, "packages", p, "tests")),
];
const EXTRA_FILES = [join(ROOT, "scratch-prime-demo.ts")];

const HAN = /[\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}]/u;

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: false })) {
		const rel = String(entry);
		if (!rel.endsWith(".ts") && !rel.endsWith(".tsx")) continue;
		out.push(join(dir, rel));
	}
	return out;
}

describe("english-only guard (zero Han in project code; CJK fixtures need a cjk-fixture marker)", () => {
	test("src/tests trees and the root scratch file contain no unmarked Han characters", () => {
		const offenders: string[] = [];
		for (const path of [...SCAN_ROOTS.flatMap(tsFiles), ...EXTRA_FILES]) {
			const text = readFileSync(path, "utf8");
			if (!HAN.test(text)) continue;
			if (text.includes("cjk-fixture:")) continue; // sanctioned CJK test data, marked per file
			const line = text.split("\n").findIndex((l) => HAN.test(l));
			offenders.push(`${path.replace(`${ROOT}/`, "")}:${line + 1}`);
		}
		expect(
			offenders,
			`unmarked Han characters in project code (mark real CJK fixtures with a cjk-fixture: comment):\n${offenders.join("\n")}`,
		).toEqual([]);
	});
});
