import { z } from "zod";

export const MaterialRecordSchema = z.object({
	source: z.string(),
	id: z.string(),
	formula: z.string().optional(),
	properties: z.record(z.string(), z.number()).default({}),
	provenance: z.record(z.string(), z.unknown()).default({}),
});
export type MaterialRecord = z.infer<typeof MaterialRecordSchema>;

export const PropertyClaimSchema = z.object({
	property: z.string().optional(),
	value: z.number().optional(),

	tolerance: z.number().positive().default(0.05),
});
export type PropertyClaimInput = z.input<typeof PropertyClaimSchema>;
export type PropertyClaim = z.infer<typeof PropertyClaimSchema>;

export type NoveltyClassification = "known" | "refines" | "contradicts" | "novel_candidate" | "unverified";

export interface NoveltyVerdict {
	classification: NoveltyClassification;
	rationale: string;
	conflictingValues?: number[];
}

export function classifyNovelty(
	records: readonly MaterialRecord[],
	claimInput: PropertyClaimInput,
	options: { sourceFailed?: boolean } = {},
): NoveltyVerdict {
	const claim = PropertyClaimSchema.parse(claimInput);
	// Source failure is fail-closed to unverified BEFORE any records are considered: an unreachable source can
	// never provide the "no match in known databases" evidence a novel_candidate verdict requires.
	if (options.sourceFailed) {
		return {
			classification: "unverified",
			rationale: "Data source unreachable: cannot distinguish novel from unverified",
		};
	}
	if (records.length === 0) {
		return {
			classification: "novel_candidate",
			rationale:
				"No match in known databases — still a candidate; must pass structure-matching and independent-computation post-gates",
		};
	}
	const { property, value, tolerance } = claim;
	if (property === undefined || value === undefined) {
		return {
			classification: "known",
			rationale: "Structure already exists in known databases (no property claim to compare against)",
		};
	}
	const knownValues = records
		.map((record) => record.properties[property])
		.filter((known): known is number => known !== undefined);
	if (knownValues.length === 0) {
		return {
			classification: "refines",
			rationale: `Known structure but none carry the ${property} property — a complementary new measurement`,
		};
	}
	// Mixed tolerance: near-zero properties (metal band_gap=0, elemental formation energy=0) use absolute comparison, avoiding relative-difference divergence at 0 that would false-report contradicts.
	// When known≈0 compare |value| against the absolute tolerance threshold; otherwise use the symmetric relative difference (denominator is the larger of the two, guarding against a 0 denominator).
	const conflicting = knownValues.filter((known) => {
		const absDiff = Math.abs(known - value);
		if (Math.abs(known) < 1e-12) return Math.abs(value) > tolerance;
		const scale = Math.max(Math.abs(known), Math.abs(value));
		return absDiff / Math.max(scale, 1e-9) > tolerance;
	});
	if (conflicting.length === knownValues.length) {
		return {
			classification: "contradicts",
			rationale: `Exceeds tolerance against all ${knownValues.length} known records`,
			conflictingValues: conflicting,
		};
	}
	return { classification: "known", rationale: "Property value within tolerance of known records" };
}

export interface NoveltyGateEvidence {
	structureMatched: boolean;
	independentCalculation: boolean;
}

export function canPromoteToVerified(classification: NoveltyClassification, evidence: NoveltyGateEvidence): boolean {
	if (classification !== "novel_candidate") return false;
	return evidence.structureMatched && evidence.independentCalculation;
}
