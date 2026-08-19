import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { mechanismFidelitySatisfied, parseVerdict, VERIFIER_SYSTEM_PROMPT, verifyClaim } from "../src/acceptance.ts";

describe("adversarial verifier verdict parsing (M3)", () => {
	test("UPHELD with reasons parses as not refuted", () => {
		const verdict = parseVerdict("UPHELD:\n- controls present\n- variance reported across 3 seeds");
		expect(verdict.refuted).toBe(false);
		expect(verdict.reasons).toHaveLength(2);
	});

	test("REFUTED with FIX list parses fail-closed fields", () => {
		const verdict = parseVerdict(
			"REFUTED:\n- single run, no variance\n- citation DOI not resolvable\nFIX:\n- rerun with seeds [0,1,2]\n- supply DOI",
		);
		expect(verdict.refuted).toBe(true);
		expect(verdict.reasons).toContain("single run, no variance");
		expect(verdict.requiredFixes).toContain("supply DOI");
	});

	test("garbage/empty output defaults to refuted (fail-closed)", () => {
		expect(parseVerdict("").refuted).toBe(true);
		expect(parseVerdict("I think maybe it is fine?").refuted).toBe(true);
	});

	test("verdict anchored on first non-empty line: later 'UPHELD' in reasons cannot flip REFUTED", () => {
		const verdict = parseVerdict(
			"REFUTED:\n- the author claims UPHELD elsewhere, but the evidence is a single run\n- no variance reported",
		);
		expect(verdict.refuted).toBe(true);
		expect(verdict.reasons).toContain("the author claims UPHELD elsewhere, but the evidence is a single run");

		// And the reverse: a leading UPHELD does not flip because of a later REFUTED quote
		expect(parseVerdict("UPHELD:\n- controls present\n- the REFUTED case was addressed in round 2").refuted).toBe(
			false,
		);
		// Leading empty lines do not affect anchoring
		expect(parseVerdict("\n\nUPHELD:\n- fine").refuted).toBe(false);
		expect(parseVerdict("\n  REFUTED:\n- prior reviewer wrote UPHELD in error").refuted).toBe(true);
	});
});

describe("mechanism fidelity check (M3, CAWM)", () => {
	test("both regime-shift and recomputation required", () => {
		expect(mechanismFidelitySatisfied({ regimeShiftPerformed: true, independentRecomputation: true })).toBe(true);
		expect(mechanismFidelitySatisfied({ regimeShiftPerformed: true, independentRecomputation: false })).toBe(false);
		expect(mechanismFidelitySatisfied({ regimeShiftPerformed: false, independentRecomputation: true })).toBe(false);
	});

	test("missing/undefined fields → fail-closed (must not count as satisfied)", () => {
		type Check = Parameters<typeof mechanismFidelitySatisfied>[0];
		// Adversarial shape: fields on the parsed check object are missing (JSON key absent / undefined)
		expect(mechanismFidelitySatisfied({} as Check)).toBeFalsy();
		expect(mechanismFidelitySatisfied({ regimeShiftPerformed: true } as unknown as Check)).toBeFalsy();
		expect(mechanismFidelitySatisfied({ independentRecomputation: true } as unknown as Check)).toBeFalsy();
		expect(
			mechanismFidelitySatisfied({
				regimeShiftPerformed: undefined,
				independentRecomputation: undefined,
			} as unknown as Check),
		).toBeFalsy();
	});
});

describe("verifyClaim error paths fail-closed (provider refusal does not throw a bare exception)", () => {
	test("streamSimple throws synchronously → REFUTED + retry fix", async () => {
		const models = {
			streamSimple: () => {
				throw new Error("provider down");
			},
		};
		const verdict = await verifyClaim({
			claim: "x improves y",
			evidence: "none",
			models: models as unknown as Models,
			model: {} as Model<Api>,
		});
		expect(verdict.refuted).toBe(true);
		expect(verdict.reasons.join(" ")).toContain("provider down");
		expect(verdict.requiredFixes).toContain("retry verification once the model is reachable");
	});

	test("hung stream is cut by the idle watchdog and retried (via streamWithRetry, no bare call)", async () => {
		const doneMessage = {
			role: "assistant",
			content: [{ type: "text", text: "UPHELD:\n- controls present" }],
			stopReason: "stop",
			timestamp: Date.now(),
		} as never;
		// attempt 1: a socket that never yields any event (silent hang); attempt 2: a clean UPHELD
		const hung = createAssistantMessageEventStream();
		const upheld = createAssistantMessageEventStream();
		upheld.push({ type: "done", message: doneMessage } as never);
		let calls = 0;
		const models = {
			streamSimple: () => {
				calls++;
				return calls === 1 ? hung : upheld;
			},
		};
		const verdict = await verifyClaim({
			claim: "x improves y",
			evidence: "3-seed run with controls",
			models: models as unknown as Models,
			model: {} as Model<Api>,
			idleTimeoutMs: 40,
		});
		expect(calls).toBe(2); // the hang was detected and the stream retried, not awaited forever
		expect(verdict.refuted).toBe(false);
		expect(verdict.reasons).toContain("controls present");
	}, 15_000);
});

describe("verifier prompt copy pins (stable model-visible text, DSH discipline)", () => {
	test("output format lines and fail-closed semantics kept verbatim", () => {
		expect(VERIFIER_SYSTEM_PROMPT).toContain("Reply EXACTLY in this format:");
		expect(VERIFIER_SYSTEM_PROMPT).toContain("UPHELD: <or REFUTED:>");
		expect(VERIFIER_SYSTEM_PROMPT).toContain("FIX:");
		// fail-closed default + audit-not-author discipline
		expect(VERIFIER_SYSTEM_PROMPT).toContain("When uncertain, rule REFUTED");
		expect(VERIFIER_SYSTEM_PROMPT).toContain("Audit, do not author");
		expect(VERIFIER_SYSTEM_PROMPT).toContain("judge only the evidence provided");
	});
});
