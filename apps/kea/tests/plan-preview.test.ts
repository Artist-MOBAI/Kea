import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { PLAN_PREVIEW_MAX_BYTES, readPlanPreviewText } from "../src/tui/plan-preview.ts";
import { makeTempDir, removeTempDir } from "./helpers/temp-dir.ts";

/**
 * plan preview read (runs asynchronously inside the approval flow):
 * any read failure must degrade to undefined and never throw — throwing would reject the approval promise,
 * the approval panel would never appear, and the user would be stuck in plan mode.
 */

const dirs: string[] = [];
afterAll(async () => {
	for (const d of dirs) await removeTempDir(d).catch(() => {});
});

async function tmp(): Promise<string> {
	const d = await makeTempDir("kea-plan-preview-");
	dirs.push(d);
	return d;
}

describe("readPlanPreviewText (fault tolerance + bounded slice)", () => {
	test("readable file returns the full text", async () => {
		const d = await tmp();
		const p = join(d, "plan.md");
		await writeFile(p, "# Plan\n- step 1\n- step 2");
		expect(await readPlanPreviewText(p)).toBe("# Plan\n- step 1\n- step 2");
	});

	test("over the cap reads only the head slice (default cap 200KB)", async () => {
		const d = await tmp();
		const p = join(d, "big.md");
		await writeFile(p, "a".repeat(PLAN_PREVIEW_MAX_BYTES + 1024));
		const text = await readPlanPreviewText(p);
		expect(text).toBeDefined();
		expect(text?.length).toBe(PLAN_PREVIEW_MAX_BYTES);
	});

	test("the maxBytes parameter takes effect", async () => {
		const d = await tmp();
		const p = join(d, "slice.md");
		await writeFile(p, "0123456789");
		expect(await readPlanPreviewText(p, 4)).toBe("0123");
	});

	test("a missing path returns undefined (no throw)", async () => {
		const d = await tmp();
		expect(await readPlanPreviewText(join(d, "missing.md"))).toBeUndefined();
	});

	test("an undefined path returns undefined", async () => {
		expect(await readPlanPreviewText(undefined)).toBeUndefined();
	});

	test("reading a directory as a file returns undefined (EISDIR does not throw)", async () => {
		const d = await tmp();
		expect(await readPlanPreviewText(d)).toBeUndefined();
	});

	test("an empty file returns an empty string (the caller degrades it to an empty hint)", async () => {
		const d = await tmp();
		const p = join(d, "empty.md");
		await writeFile(p, "");
		expect(await readPlanPreviewText(p)).toBe("");
	});
});
