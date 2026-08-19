import { fetchWithDeadline, type MaterialRecord } from "@kea/research";
import { z } from "zod";

const MP_BASE = "https://api.materialsproject.org";

export const MpSummaryResponseSchema = z.object({
	data: z.array(z.record(z.string(), z.unknown())).default([]),
});

export interface MpQueryOptions {
	formula?: string;
	materialId?: string;
	limit?: number;
}

export function buildMpSummaryUrl(options: MpQueryOptions): string {
	const params = new URLSearchParams();
	if (options.formula) params.set("formula", options.formula);
	if (options.materialId) params.set("material_ids", options.materialId);
	params.set(
		"fields",
		"material_id,formula_pretty,formation_energy_per_atom,energy_above_hull,band_gap,bulk_modulus,shear_modulus,density,task_ids",
	);
	params.set("limit", String(Math.min(options.limit ?? 10, 100)));
	return `${MP_BASE}/materials/summary/?${params.toString()}`;
}

export function mapMpDocument(doc: Record<string, unknown>): MaterialRecord {
	const properties: Record<string, number> = {};
	const fields = [
		"formation_energy_per_atom",
		"energy_above_hull",
		"band_gap",
		"bulk_modulus",
		"shear_modulus",
		"density",
	] as const;
	for (const field of fields) {
		const value = doc[field];
		if (typeof value === "number" && Number.isFinite(value)) properties[field] = value;
	}
	const id = String(doc.material_id ?? "unknown");
	return {
		source: "materials-project",
		id,
		formula: typeof doc.formula_pretty === "string" ? doc.formula_pretty : undefined,
		properties,
		provenance: {
			db_id: id,
			entry_url: `https://materialsproject.org/materials/${id}`,
			task_ids: Array.isArray(doc.task_ids) ? doc.task_ids : [],
			functional: "computed (MP methodology; see task provenance)",
		},
	};
}

export async function queryMaterialsProject(
	apiKey: string,
	options: MpQueryOptions,
	fetchImpl: typeof fetch = fetch,
): Promise<MaterialRecord[]> {
	const response = await fetchWithDeadline(
		buildMpSummaryUrl(options),
		{ headers: { "X-API-KEY": apiKey, Accept: "application/json" } },
		{ fetchImpl },
	);
	if (response.status === 401) throw new Error("MP_API_KEY invalid (401)");
	if (!response.ok) throw new Error(`Materials Project ${response.status}`);
	// fail-closed, same policy as domain-literature (mapS2Response): malformed response → empty result; the fallback chain takes over
	const parsed = MpSummaryResponseSchema.safeParse(await response.json());
	if (!parsed.success) return [];
	return parsed.data.data.map(mapMpDocument);
}
