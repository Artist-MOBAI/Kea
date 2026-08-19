import { describe, expect, test } from "vitest";
import { buildGate1Script, buildGate1SpawnOptions, parseGate1Output } from "../src/gate1.ts";

describe("Gate 1 script and parsing (M5)", () => {
	test("script contains stepwise replay and RESULT_JSON output", () => {
		const script = buildGate1Script([
			{
				reaction_smarts: "[C:1](=O)[OH].[N:2]>>[C:1](=O)[N:2]",
				reactants: ["CC(=O)O", "N"],
				expected_product: "CC(=O)N",
			},
		]);
		expect(script).toContain("ReactionFromSmarts");
		expect(script).toContain("RESULT_JSON:");
		expect(script).toContain("expected_product");
		// Atom conservation is not just defined: the script must actually run the check and exit non-zero on failure
		expect(script).toContain("conservation_violations(reactant_counts, product_counts)");
		expect(script).toContain("sys.exit(0 if overall else 1)");
	});

	test("parseGate1Output extracts the RESULT_JSON line; undefined when absent", () => {
		const ok = parseGate1Output(
			'noise\nRESULT_JSON:{"pass":true,"steps":[{"index":0,"ok":true,"detail":"product=x"}]}\n',
		);
		expect(ok?.pass).toBe(true);
		expect(ok?.steps[0]?.ok).toBe(true);
		expect(parseGate1Output("no result marker")).toBeUndefined();
	});

	test("buildGate1SpawnOptions: 5-minute timeout + pipe capture (P2-5 regression)", () => {
		const opts = buildGate1SpawnOptions("/tmp/work");
		expect(opts.timeout).toBe(300_000);
		expect(opts.stdout).toBe("pipe");
		expect(opts.stderr).toBe("pipe");
		expect(opts.cwd).toBe("/tmp/work");
	});
});
