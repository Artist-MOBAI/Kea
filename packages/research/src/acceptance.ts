import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { STREAM_IDLE_TIMEOUT_MS, streamWithRetry } from "@kea/core";
import { z } from "zod";
import { reasonOf } from "./http.ts";

export const VerifierVerdictSchema = z.object({
	refuted: z.boolean(),
	reasons: z.array(z.string()).default([]),
	requiredFixes: z.array(z.string()).default([]),
});
export type VerifierVerdict = z.infer<typeof VerifierVerdictSchema>;

export const VERIFIER_SYSTEM_PROMPT = [
	"You are an adversarial scientific verifier. Your task is to REFUTE the claim. When uncertain, rule REFUTED — letting a false claim through is worse than demanding another round of evidence.",
	"",
	"Audit, do not author: judge only the evidence provided. Never invent requirements beyond the claim's contract, and never refute on grounds the claim excludes.",
	"Difficulty, ambition, or novelty of the claim is not a refutation ground; refute only on the evidence failures listed below.",
	"",
	"Fail on:",
	"- Missing controls, confounds, or data leakage into evaluation.",
	"- Single-run results without variance; improvements inside noise.",
	"- Unverifiable citations (no resolvable DOI) or citations that do not support the claim.",
	"- Mechanism claims unsupported by the evidence.",
	"- Evaluator/scope deviation or reward-hacking of the scoring contract.",
	"",
	"Every reason must be specific and actionable (what is missing, where, how to fix it).",
	"",
	"Reply EXACTLY in this format:",
	"UPHELD: <or REFUTED:>",
	"- <reason 1>",
	"- <reason 2>",
	"FIX:",
	"- <required fix 1>",
].join("\n");

// The verdict is anchored on the first non-empty line only: any "UPHELD" mention elsewhere in the reason
// text (quote, paraphrase) must not flip the verdict. A first non-empty line that is not UPHELD is REFUTED (fail-closed).
export function parseVerdict(text: string): VerifierVerdict {
	const firstLine = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line !== "");
	const refuted = firstLine === undefined || !/^UPHELD\b/i.test(firstLine);
	const reasons: string[] = [];
	const fixes: string[] = [];
	let section: "verdict" | "fix" = "verdict";
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (/^FIX\s*:?/i.test(line)) {
			section = "fix";
			continue;
		}
		if (/^(UPHELD|REFUTED)\s*:?/i.test(line)) continue;
		if (line.startsWith("- ")) {
			const item = line.slice(2).trim();
			if (item === "") continue;
			if (section === "fix") fixes.push(item);
			else reasons.push(item);
		}
	}
	return VerifierVerdictSchema.parse({ refuted, reasons, requiredFixes: fixes });
}

export async function verifyClaim(args: {
	claim: string;
	evidence: string;
	models: Models;
	model: Model<Api>;
	/** Idle-watchdog override for the verifier stream (default STREAM_IDLE_TIMEOUT_MS). */
	idleTimeoutMs?: number;
}): Promise<VerifierVerdict> {
	const { claim, evidence, models, model } = args;
	try {
		// streamWithRetry adds the idle watchdog + pre-content retry the bare streamSimple call lacked —
		// a silently hung verifier socket must fail closed, not pin the tool forever
		const stream = streamWithRetry(
			() =>
				models.streamSimple(model, {
					systemPrompt: VERIFIER_SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: [
								// JSON.stringify the dynamic values: a claim/evidence containing template-breaking text must not escape its field
								{
									type: "text",
									text: `CLAIM:\n${JSON.stringify(claim)}\n\nEVIDENCE:\n${JSON.stringify(evidence)}`,
								},
							],
							timestamp: Date.now(),
						},
					],
				}),
			{ idleTimeoutMs: args.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS },
		);
		const result = await stream.result();
		if (result.stopReason === "error") {
			return VerifierVerdictSchema.parse({
				refuted: true,
				reasons: [`verifier invocation failed: ${result.errorMessage ?? "unknown"}`],
				requiredFixes: ["retry verification once the model is reachable"],
			});
		}
		const text = result.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		return parseVerdict(text);
	} catch (err) {
		// Provider rejection / stream throw must fail closed to REFUTED, never surface as an uncaught tool error.
		return VerifierVerdictSchema.parse({
			refuted: true,
			reasons: [`verifier invocation failed: ${reasonOf(err)}`],
			requiredFixes: ["retry verification once the model is reachable"],
		});
	}
}

export interface MechanismFidelityCheck {
	regimeShiftPerformed: boolean;

	independentRecomputation: boolean;
	note?: string;
}

export function mechanismFidelitySatisfied(check: MechanismFidelityCheck): boolean {
	// Wrapped in Boolean(): with missing fields, && returns undefined, which does not match the declared boolean return type
	return Boolean(check.regimeShiftPerformed && check.independentRecomputation);
}
