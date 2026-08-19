import { fetchWithDeadline, type MaterialRecord } from "@kea/research";
import { z } from "zod";

export const DEFAULT_OPTIMADE_BASE = "https://optimade.materialsproject.org/v1";

const OptimadeEntrySchema = z.object({
	// OPTIMADE 1.2 (JSON:API): `id` is a TOP-LEVEL field on the resource object, not inside `attributes`
	id: z.string().optional(),
	attributes: z.record(z.string(), z.unknown()).nullish(),
});
type OptimadeEntry = z.infer<typeof OptimadeEntrySchema>;

export const OptimadeResponseSchema = z.object({
	data: z.array(OptimadeEntrySchema).default([]),
});

export interface OptimadeFilterOptions {
	elements?: string[];
	nelements?: number;
	formula?: string;
	/** Advanced escape hatch: an extra clause appended verbatim to the filter. Callers own the consequences — agent input must not reach here. */
	extra?: string;
}

/** Element-symbol whitelist: agent-provided elements go straight into the filter, so they must be sanitized against injection first. */
const ELEMENT_PATTERN = /^[A-Z][a-z]?$/;

// reduced-formula whitelist (same strategy as elements): a run of element symbols with optional
// stoichiometric counts, e.g. Bi2Te3 / Si / H2O. Any other character — quotes, spaces, operators —
// discards the whole clause (under-filter beats a corrupted filter; agent input is never
// concatenated into the filter string verbatim).
const FORMULA_PATTERN = /^(?:[A-Z][a-z]?\d*)+$/;

export function buildFilter(options: OptimadeFilterOptions): string {
	const clauses: string[] = [];
	// nelements accepts integers only; invalid values are dropped (better to under-filter than to corrupt the filter)
	if (options.nelements !== undefined && Number.isInteger(options.nelements)) {
		clauses.push(`nelements=${options.nelements}`);
	}
	if (options.elements && options.elements.length > 0) {
		for (const el of options.elements) {
			if (ELEMENT_PATTERN.test(el)) clauses.push(`elements HAS "${el}"`);
		}
	}
	if (options.formula !== undefined && FORMULA_PATTERN.test(options.formula)) {
		clauses.push(`chemical_formula_reduced="${options.formula}"`);
	}
	if (options.extra) clauses.push(options.extra);
	return clauses.join(" AND ");
}

export function buildOptimadeUrl(base: string, filter: string, limit: number): string {
	const params = new URLSearchParams({
		filter,
		response_fields:
			"id,chemical_formula_reduced,structure_features,_mp_formation_energy_per_atom,_mp_band_gap,_mp_bulk_modulus,_mp_shear_modulus,density",
		page_limit: String(limit),
	});
	return `${base.replace(/\/$/, "")}/structures?${params.toString()}`;
}

export function mapOptimadeStructure(
	entry: { id?: string; attributes: Record<string, unknown> },
	providerUrl: string,
): MaterialRecord {
	const attributes = entry.attributes;
	const id = String(entry.id ?? attributes.id ?? "unknown");
	const properties: Record<string, number> = {};
	const numericFields: Array<[string, string]> = [
		["_mp_formation_energy_per_atom", "formation_energy_per_atom"],
		["_mp_band_gap", "band_gap"],
		["_mp_bulk_modulus", "bulk_modulus"],
		["_mp_shear_modulus", "shear_modulus"],
		["density", "density"],
	];
	for (const [source, target] of numericFields) {
		const value = attributes[source];
		if (typeof value === "number" && Number.isFinite(value)) properties[target] = value;
	}
	// MP's OPTIMADE provider landing page maps to materialsproject.org; a generic OPTIMADE provider's structure detail page is /structures/<id>
	const isMp = providerUrl.includes("optimade.materialsproject.org");
	const entryUrl = isMp
		? `https://materialsproject.org/materials/${id}`
		: `${providerUrl.replace(/\/v1\/?$/, "")}/structures/${id}`;
	return {
		source: "optimade",
		id,
		formula: typeof attributes.chemical_formula_reduced === "string" ? attributes.chemical_formula_reduced : undefined,
		properties,
		provenance: {
			db_id: id,
			entry_url: entryUrl,
			spec: "OPTIMADE 1.2",
		},
	};
}

export async function queryOptimade(
	options: OptimadeFilterOptions & { base?: string; limit?: number },
	fetchImpl: typeof fetch = fetch,
): Promise<MaterialRecord[]> {
	const base = options.base ?? DEFAULT_OPTIMADE_BASE;
	const filter = buildFilter(options);
	if (filter === "") throw new Error("optimade query needs at least one filter clause");
	const url = buildOptimadeUrl(base, filter, Math.min(options.limit ?? 10, 100));
	const response = await fetchWithDeadline(url, { headers: { Accept: "application/vnd.api+json" } }, { fetchImpl });
	if (!response.ok) throw new Error(`OPTIMADE ${response.status}`);
	// fail-closed, same policy as domain-literature: malformed response → empty result; entries missing attributes are dropped individually (never invalidate the whole batch)
	const parsed = OptimadeResponseSchema.safeParse(await response.json());
	if (!parsed.success) return [];
	return parsed.data.data
		.filter((entry): entry is OptimadeEntry & { attributes: Record<string, unknown> } => entry.attributes != null)
		.map((entry) => mapOptimadeStructure(entry, base));
}
