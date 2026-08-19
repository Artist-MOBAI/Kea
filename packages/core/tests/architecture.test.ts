import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");

interface ScanResult {
	files: number;
	imports: Array<{ file: string; target: string }>;
}

async function collectImports(dir: string): Promise<ScanResult> {
	const results: Array<{ file: string; target: string }> = [];
	let files = 0;
	const glob = new Bun.Glob("**/*.ts");
	// Do not swallow scan errors: a missing directory must fail loudly, not return an empty array and pass falsely
	for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) {
		if (file.includes("node_modules") || file.includes("/tests/")) continue;
		files += 1;
		const text = await Bun.file(join(dir, file)).text();
		// Cover three import forms: static from (single/double quotes), dynamic import(), and side-effect import
		for (const match of text.matchAll(/(?:from\s*|import\(\s*|import\s+)(["'])(@kea\/[a-z-]+)\1/g)) {
			results.push({ file, target: match[2] ?? "" });
		}
	}
	return { files, imports: results };
}

describe("architecture boundary guard (M6)", () => {
	test("core does not depend on research / domain / apps", async () => {
		const { files, imports } = await collectImports(join(REPO_ROOT, "packages", "core", "src"));
		// Empty-scan guard: core/src uses only relative imports (@kea import count is legitimately 0), so assert file count to prove the scan really ran
		expect(files).toBeGreaterThan(0);
		const violations = imports.filter((i) => i.target !== "@kea/core");
		expect(violations).toEqual([]);
	});

	test("research may only depend on core (not domain / apps)", async () => {
		const { files, imports } = await collectImports(join(REPO_ROOT, "packages", "research", "src"));
		expect(files).toBeGreaterThan(0);
		// research genuinely depends on @kea/core: the scan must actually collect imports; an empty result must not pass
		expect(imports.length).toBeGreaterThan(0);
		const violations = imports.filter((i) => i.target !== "@kea/research" && i.target !== "@kea/core");
		expect(violations).toEqual([]);
	});

	test("domain packages may only depend on core / research", async () => {
		let totalImports = 0;
		for (const pkg of ["domain-materials", "domain-literature", "domain-chemistry"]) {
			const { files, imports } = await collectImports(join(REPO_ROOT, "packages", pkg, "src"));
			expect(files, pkg).toBeGreaterThan(0);
			totalImports += imports.length;
			const violations = imports.filter(
				(i) => i.target !== `@kea/${pkg}` && i.target !== "@kea/core" && i.target !== "@kea/research",
			);
			expect(violations, pkg).toEqual([]);
		}
		// domain-literature currently has no @kea imports (zod/pi-ai only), so assert the total across all three packages
		expect(totalImports).toBeGreaterThan(0);
	});
});
