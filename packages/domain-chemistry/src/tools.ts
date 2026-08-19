import { Type } from "@earendil-works/pi-ai";
import { reasonOf } from "@kea/research";
import type { Static } from "typebox";
import { type ReactionStep, runGate1 } from "./gate1.ts";

const parameters = Type.Object({
	cwd: Type.Optional(
		Type.String({ description: "working directory for the locked rdkit venv (default: process cwd)" }),
	),
	steps: Type.Array(
		Type.Object({
			reaction_smarts: Type.String(),
			reactants: Type.Array(Type.String()),
			expected_product: Type.Optional(Type.String()),
			label: Type.Optional(Type.String()),
		}),
		{ minItems: 1 },
	),
});

export function createValidateReactionsTool() {
	return {
		name: "validate_reactions",
		label: "Validate reactions",
		description:
			"Gate 1 of synthesis validation: replay each reaction SMARTS with RDKit (product match + weak atom-conservation check — product elements must be a subset of reactants, so leaving groups such as water are allowed). Machine-verdict only.",
		parameters,
		executionMode: "sequential",
		async execute(_id: string, params: Static<typeof parameters>) {
			const cwd = params.cwd ?? process.cwd();
			try {
				const result = await runGate1(cwd, params.steps as ReactionStep[]);
				const lines = [`gate1_replay: ${result.pass ? "PASS" : "FAIL"}`];
				for (const step of result.steps) {
					lines.push(`  step ${step.index}: ${step.ok ? "ok" : "FAIL"} ${step.detail}`);
				}
				if (result.error) lines.push(`error: ${result.error}`);
				lines.push(
					"Later gates (inventory reachability / literature grounding / condition rationale) are verified by the agent.",
				);
				return { content: [{ type: "text", text: lines.join("\n") }], details: { pass: result.pass } };
			} catch (err) {
				return {
					content: [{ type: "text", text: `Gate 1 failed: ${reasonOf(err)}` }],
					details: {},
					isError: true,
				};
			}
		},
	};
}
