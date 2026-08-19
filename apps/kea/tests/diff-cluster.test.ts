import { describe, expect, test } from "vitest";
import { clusterDiffPreview, computeDiffLines } from "../src/tui/components/dialogs/diff-cluster.ts";

describe("line-level LCS diff (kimi computeDiffLines pattern)", () => {
	test("add/delete/context classification is correct", () => {
		const lines = computeDiffLines("a\nb\nc", "a\nx\nc");
		expect(lines).toBeDefined();
		const kinds = lines?.map((l) => `${l.kind}:${l.code}`);
		expect(kinds).toEqual(["context:a", "delete:b", "add:x", "context:c"]);
	});

	test("empty old text = all adds", () => {
		const lines = computeDiffLines("", "n1\nn2");
		expect(lines?.map((l) => l.kind)).toEqual(["add", "add"]);
	});

	test("oversized diff degrades (LCS over the limit returns undefined)", () => {
		const old = Array.from({ length: 600 }, (_, i) => `old-${i}`).join("\n");
		const neu = Array.from({ length: 600 }, (_, i) => `new-${i}`).join("\n");
		expect(computeDiffLines(old, neu)).toBeUndefined();
	});
});

describe("clusterDiffPreview (clustered rendering, kimi renderDiffLinesClustered pattern)", () => {
	test("stats header: +adds -dels path", () => {
		const out = clusterDiffPreview("a\nb\nc", "a\nx\nc", "src/a.ts");
		expect(out).toBeDefined();
		expect(out?.[0]).toEqual({ kind: "header", text: "+1 -1 src/a.ts" });
	});

	test("gap between clusters renders N unchanged lines", () => {
		const old = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
		const updated = old.replace("line-2", "TWO").replace("line-17", "SEVENTEEN");
		const out = clusterDiffPreview(old, updated, "f.ts", 2);
		expect(out).toBeDefined();
		const gaps = out?.filter((l) => l.kind === "gap") ?? [];
		expect(gaps.length).toBe(1);
		expect(gaps[0]?.text).toMatch(/unchanged lines/);
		const texts = out?.map((l) => l.text) ?? [];
		expect(texts).toContain("TWO");
		expect(texts).toContain("SEVENTEEN");
	});

	test("no changes: only the stats header", () => {
		const out = clusterDiffPreview("same", "same", "f.ts");
		expect(out).toEqual([{ kind: "header", text: "f.ts" }]);
	});

	test("context never exceeds contextLines rows", () => {
		const old = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
		const neu = old.replace("l15", "X");
		const out = clusterDiffPreview(old, neu, "f.ts", 3);
		expect(out?.length).toBe(9);
	});
});
