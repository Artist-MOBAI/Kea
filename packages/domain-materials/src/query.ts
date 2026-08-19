import { type MaterialRecord, reasonOf } from "@kea/research";
import { queryMaterialsProject } from "./materialsproject.ts";
import { queryOptimade } from "./optimade.ts";

export interface MaterialQuery {
	formula?: string;
	elements?: string[];
	nelements?: number;
}

export interface MaterialQueryResult {
	records: MaterialRecord[];
	source: "materials-project" | "optimade" | "none";
	sourceFailed: boolean;
	/** true when the query has no searchable criteria (empty/invalid formula) — distinct from an unreachable source */
	noCriteria?: boolean;
	error?: string;
}

function parseFormulaElements(formula: string): string[] {
	return [...formula.matchAll(/([A-Z][a-z]?)/g)].map((m) => m[1] ?? "");
}

export async function queryMaterial(
	query: MaterialQuery,
	fetchImpl: typeof fetch = fetch,
): Promise<MaterialQueryResult> {
	const apiKey = process.env.MP_API_KEY;

	if (apiKey && query.formula) {
		try {
			const records = await queryMaterialsProject(apiKey, { formula: query.formula }, fetchImpl);
			if (records.length > 0) return { records, source: "materials-project", sourceFailed: false };
		} catch (err) {
			return optimadeFallback(query, `MP failed: ${reasonOf(err)}`, fetchImpl);
		}
	}

	return optimadeFallback(query, undefined, fetchImpl);
}

async function optimadeFallback(
	query: MaterialQuery,
	upstreamError: string | undefined,
	fetchImpl: typeof fetch,
): Promise<MaterialQueryResult> {
	const elements = query.elements ?? (query.formula ? parseFormulaElements(query.formula) : []);
	const hasCriteria = elements.length > 0 || query.nelements !== undefined;
	if (!hasCriteria) {
		// No queryable criteria (empty/invalid formula) ≠ unreachable source: the error text differs, but it is still fail-closed sourceFailed
		return {
			records: [],
			source: "none",
			sourceFailed: true,
			noCriteria: true,
			error: "no queryable material criteria (provide formula or elements)",
		};
	}
	try {
		// The fallback intentionally drops the formula filter (formula: undefined): OPTIMADE matches by element set only,
		// preferring loose matches over a strict-formula miss — conservative toward "known" for novelty, behavior unchanged.
		const records = await queryOptimade({ elements, nelements: query.nelements, formula: undefined }, fetchImpl);
		return { records, source: "optimade", sourceFailed: false, error: upstreamError };
	} catch (err) {
		return {
			records: [],
			source: "none",
			sourceFailed: true,
			error: [upstreamError, `OPTIMADE failed: ${reasonOf(err)}`].filter(Boolean).join("; "),
		};
	}
}
