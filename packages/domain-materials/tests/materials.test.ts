import { describe, expect, test } from "vitest";
import { buildMpSummaryUrl, mapMpDocument } from "../src/materialsproject.ts";
import { buildFilter, buildOptimadeUrl, mapOptimadeStructure } from "../src/optimade.ts";
import { queryMaterial } from "../src/query.ts";

describe("OPTIMADE (M5)", () => {
	test("filter combination: elements HAS / nelements", () => {
		expect(buildFilter({ elements: ["Bi", "Te"], nelements: 2 })).toBe(
			'nelements=2 AND elements HAS "Bi" AND elements HAS "Te"',
		);
		expect(buildFilter({ formula: "Bi2Te3" })).toBe('chemical_formula_reduced="Bi2Te3"');
	});

	test("filter sanitization: invalid element symbols dropped, non-integer nelements omitted (injection-safe)", () => {
		expect(buildFilter({ elements: ["Bi", 'Te" OR id="x', "lower", "H"], nelements: 2.5 })).toBe(
			'elements HAS "Bi" AND elements HAS "H"',
		);
		expect(buildFilter({ elements: ["bad!"], nelements: Number.NaN })).toBe("");
	});

	test("filter sanitization: formula treated like elements — injection strings dropped whole, not spliced", () => {
		expect(buildFilter({ formula: 'Bi2Te3" OR id="x' })).toBe("");
		expect(buildFilter({ formula: "Bi2Te3", extra: undefined })).toBe('chemical_formula_reduced="Bi2Te3"');
		expect(buildFilter({ formula: 'x" OR 1=1', elements: ["Si"] })).toBe('elements HAS "Si"');
		expect(buildFilter({ formula: "H2O" })).toBe('chemical_formula_reduced="H2O"');
	});

	test("URL construction carries response_fields and page_limit", () => {
		const url = buildOptimadeUrl("https://optimade.materialsproject.org/v1", "nelements=2", 5);
		expect(url).toContain("/structures?");
		expect(url).toContain("page_limit=5");
		expect(url).toContain("response_fields=");
	});

	test("structure mapping: numeric property extraction + complete provenance", () => {
		const record = mapOptimadeStructure(
			{
				id: "mp-123",
				attributes: {
					chemical_formula_reduced: "Bi2Te3",
					_mp_band_gap: 0.15,
					_mp_formation_energy_per_atom: -0.3,
					density: 7.7,
					_mp_bulk_modulus: null,
				},
			},
			"https://optimade.materialsproject.org/v1",
		);
		expect(record.properties.band_gap).toBe(0.15);
		expect(record.properties.bulk_modulus).toBeUndefined();
		expect(record.provenance.entry_url).toContain("mp-123");
		expect(record.provenance.spec).toBe("OPTIMADE 1.2");
	});
});

describe("Materials Project (M5)", () => {
	test("URL carries the field list and formula", () => {
		const url = buildMpSummaryUrl({ formula: "Bi2Te3", limit: 5 });
		expect(url).toContain("materials/summary/");
		expect(url).toContain("formula=Bi2Te3");
		expect(url).toContain("energy_above_hull");
	});

	test("document mapping: provenance carries entry_url and task_ids", () => {
		const record = mapMpDocument({
			material_id: "mp-23",
			formula_pretty: "Bi2Te3",
			band_gap: 0.15,
			energy_above_hull: 0,
			task_ids: ["mp-task-1"],
		});
		expect(record.source).toBe("materials-project");
		expect(record.provenance.entry_url).toContain("materialsproject.org/materials/mp-23");
		expect(record.properties.energy_above_hull).toBe(0);
	});
});

describe("queryMaterial fallback chain (M5)", () => {
	test("no key goes OPTIMADE; fetch failure → sourceFailed=true (basis for novelty unverified)", async () => {
		const okFetch = (async () =>
			new Response(
				JSON.stringify({ data: [{ attributes: { id: "mp-1", chemical_formula_reduced: "Si", _mp_band_gap: 1.1 } }] }),
				{ status: 200 },
			)) as unknown as typeof fetch;
		const result = await queryMaterial({ formula: "Si" }, okFetch);
		expect(result.source).toBe("optimade");
		expect(result.records).toHaveLength(1);

		const badFetch = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		const failed = await queryMaterial({ formula: "Si" }, badFetch);
		expect(failed.sourceFailed).toBe(true);
		expect(failed.records).toEqual([]);
	});

	test("agent-supplied elements are sanitized before entering the URL filter (injection must not appear)", async () => {
		let seenUrl = "";
		const spyFetch = (async (url: string | URL) => {
			seenUrl = decodeURIComponent(String(url)).replaceAll("+", " ");
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		}) as unknown as typeof fetch;
		const result = await queryMaterial({ elements: ["Si", 'O" AND id="x'], nelements: 1.5 }, spyFetch);
		expect(result.source).toBe("optimade");
		expect(seenUrl).toContain('elements HAS "Si"');
		expect(seenUrl).not.toContain('O" AND id=');
		expect(seenUrl).not.toContain("nelements");
	});
});
