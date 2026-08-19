import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Journal } from "../src/journal.ts";
import { canPromoteToVerified, classifyNovelty, type MaterialRecord } from "../src/novelty.ts";
import { createResearchTools, type ResearchToolsContext } from "../src/tools.ts";

const mp = (id: string, properties: Record<string, number>): MaterialRecord => ({
	source: "materials-project",
	id,
	properties,
	provenance: { db_id: id },
});

describe("novelty classification (M3)", () => {
	test("no records + healthy source → novel_candidate (still a candidate)", () => {
		const verdict = classifyNovelty([], { property: "band_gap", value: 1.2 });
		expect(verdict.classification).toBe("novel_candidate");
	});

	test("source unreachable → unverified (absence of evidence is not novelty)", () => {
		const verdict = classifyNovelty([], { property: "band_gap", value: 1.2 }, { sourceFailed: true });
		expect(verdict.classification).toBe("unverified");
	});

	test("source failure must not classify known/contradicts even when records were returned (fail-closed first)", () => {
		const verdict = classifyNovelty(
			[mp("mp-1", { band_gap: 1.2 })],
			{ property: "band_gap", value: 2.5 },
			{ sourceFailed: true },
		);
		expect(verdict.classification).toBe("unverified");
	});

	test("structure known without a property claim → refines", () => {
		const verdict = classifyNovelty([mp("mp-1", { formation_energy: -1.2 })], { property: "band_gap", value: 1.2 });
		expect(verdict.classification).toBe("refines");
	});

	test("within tolerance → known; all beyond tolerance → contradicts with conflicting values listed", () => {
		const records = [mp("mp-1", { band_gap: 1.2 }), mp("mp-2", { band_gap: 1.22 })];
		expect(classifyNovelty(records, { property: "band_gap", value: 1.21 }).classification).toBe("known");
		const contradicting = classifyNovelty(records, { property: "band_gap", value: 2.5 });
		expect(contradicting.classification).toBe("contradicts");
		expect(contradicting.conflictingValues).toEqual([1.2, 1.22]);
	});
});

describe("novelty post-gate (M3, Kea-1 text-only hint → enforced)", () => {
	test("novel_candidate promotes to verified only with both structure match and independent calculation", () => {
		expect(canPromoteToVerified("novel_candidate", { structureMatched: true, independentCalculation: true })).toBe(
			true,
		);
		expect(canPromoteToVerified("novel_candidate", { structureMatched: true, independentCalculation: false })).toBe(
			false,
		);
		expect(canPromoteToVerified("novel_candidate", { structureMatched: false, independentCalculation: true })).toBe(
			false,
		);
	});

	test("non-candidate classifications do not use the post-gate", () => {
		expect(canPromoteToVerified("known", { structureMatched: true, independentCalculation: true })).toBe(false);
		expect(canPromoteToVerified("unverified", { structureMatched: true, independentCalculation: true })).toBe(false);
	});
});

describe("check_novelty tool fail-closed (unconfigured source = unreachable)", () => {
	test("no fetchMaterialRecords → unverified, never novel_candidate", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "kea2-novelty-"));
		const journal = new Journal(workdir);
		try {
			const tools = createResearchTools({ cwd: workdir, journal } as ResearchToolsContext);
			const tool = tools.find((t) => t.name === "check_novelty");
			if (!tool) throw new Error("check_novelty tool missing");
			const result = await tool.execute("call-1", { query: "mp-new-1", property: "band_gap", value: 1.2 });
			expect(result.details.classification).toBe("unverified");
			expect(journal.list({ type: "novelty_checked" })[0]?.payload.classification).toBe("unverified");
		} finally {
			journal.close();
			await rm(workdir, { recursive: true, force: true });
		}
	});

	test("dirty source records → unverified (parse failure = source problem; never throws, never novel)", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "kea2-novelty2-"));
		const journal = new Journal(workdir);
		try {
			const tools = createResearchTools({
				cwd: workdir,
				journal,
				fetchMaterialRecords: async () => [{ garbage: true }, "not-an-object", 42],
			} as unknown as ResearchToolsContext);
			const tool = tools.find((t) => t.name === "check_novelty");
			if (!tool) throw new Error("check_novelty tool missing");
			const result = await tool.execute("call-1", { query: "mp-dirty", property: "band_gap", value: 1.2 });
			expect(result.details.classification).toBe("unverified");
			expect(journal.list({ type: "novelty_checked" })[0]?.payload.classification).toBe("unverified");
		} finally {
			journal.close();
			await rm(workdir, { recursive: true, force: true });
		}
	});
});
