import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensurePythonEnv } from "@kea/core";
import { z } from "zod";

export const ReactionStepSchema = z.object({
	reaction_smarts: z.string().min(1),
	reactants: z.array(z.string()).min(1),
	expected_product: z.string().optional(),
	label: z.string().optional(),
});
export type ReactionStep = z.infer<typeof ReactionStepSchema>;

export interface Gate1Result {
	pass: boolean;
	steps: Array<{ index: number; ok: boolean; detail: string }>;
	error?: string;
}

// Gate 1 replay script: run each SMARTS step and verify (1) a product is produced, (2) it matches
// expected_product when given, (3) atoms are conserved (incl. implicit hydrogens). SMARTS allows
// dropping leaving groups (condensation, dehydration), so only "product ⊆ reactants" is required —
// missing atoms on the reverse side are a by-product gap, not a failure. Any failed step:
// RESULT_JSON.pass=false and the process exits with code 1 (machine verdict, no silent pass).
export function buildGate1Script(steps: ReactionStep[]): string {
	return [
		"import json",
		"import sys",
		"from rdkit import Chem",
		"from rdkit.Chem import rdChemReactions",
		"",
		`STEPS = ${JSON.stringify(steps)}`,
		"",
		"def atom_counts(mol):",
		"    if mol is None:",
		"        return None",
		"    counts = {}",
		"    for atom in mol.GetAtoms():",
		"        symbol = atom.GetSymbol()",
		"        counts[symbol] = counts.get(symbol, 0) + 1",
		"        hydrogens = atom.GetTotalNumHs()",
		"        if hydrogens:",
		'            counts["H"] = counts.get("H", 0) + hydrogens',
		"    return counts",
		"",
		"def sum_counts(mols):",
		"    total = {}",
		"    for mol in mols:",
		"        counts = atom_counts(mol)",
		"        if counts is None:",
		"            return None",
		"        for symbol, n in counts.items():",
		"            total[symbol] = total.get(symbol, 0) + n",
		"    return total",
		"",
		"def conservation_violations(reactant_counts, product_counts):",
		"    violations = []",
		"    for symbol, n in sorted(product_counts.items()):",
		"        available = reactant_counts.get(symbol, 0)",
		"        if n > available:",
		'            violations.append(f"{symbol}: {n} in product > {available} in reactants")',
		"    return violations",
		"",
		"results = []",
		"overall = True",
		"for i, step in enumerate(STEPS):",
		"    detail = ''",
		"    ok = True",
		"    rxn = rdChemReactions.ReactionFromSmarts(step['reaction_smarts'])",
		"    if rxn is None:",
		"        ok = False; detail = 'invalid SMARTS'",
		"    else:",
		"        reactant_mols = [Chem.MolFromSmiles(s) for s in step['reactants']]",
		"        if None in reactant_mols:",
		"            ok = False; detail = 'invalid reactant SMILES'",
		"        else:",
		"            try:",
		"                products = rxn.RunReactants(tuple(reactant_mols))",
		"            except Exception as exc:",
		"                products = None; detail = f'reaction error: {exc}'",
		"            if products is None or len(products) == 0:",
		"                ok = False; detail = detail or 'no product produced'",
		"            else:",
		"                try:",
		"                    product_mols = list(products[0])",
		"                    if len(product_mols) == 0:",
		"                        ok = False; detail = 'no product produced'",
		"                    else:",
		"                        product_smiles = Chem.MolToSmiles(product_mols[0])",
		"                        detail = f'product={product_smiles}'",
		"                        expected = step.get('expected_product')",
		"                        if expected:",
		"                            expected_mol = Chem.MolFromSmiles(expected)",
		"                            same = (",
		"                                expected_mol is not None",
		"                                and any(Chem.MolToSmiles(expected_mol) == Chem.MolToSmiles(pm) for pm in product_mols if pm is not None)",
		"                            )",
		"                            if not same:",
		"                                ok = False; detail += f' expected={expected} MISMATCH'",
		"                        reactant_counts = sum_counts(reactant_mols)",
		"                        product_counts = sum_counts(product_mols)",
		"                        if reactant_counts is None or product_counts is None:",
		"                            ok = False; detail += ' atom-count failure'",
		"                        else:",
		"                            violations = conservation_violations(reactant_counts, product_counts)",
		"                            if violations:",
		"                                ok = False",
		"                                detail += ' ATOM CONSERVATION violated: ' + '; '.join(violations)",
		"                except Exception as exc:",
		"                    ok = False; detail = detail or f'product error: {exc}'",
		"    results.append({'index': i, 'ok': ok, 'detail': detail})",
		"    overall = overall and ok",
		"",
		'print("RESULT_JSON:" + json.dumps({"pass": overall, "steps": results}))',
		"sys.exit(0 if overall else 1)",
	].join("\n");
}

export function parseGate1Output(stdout: string): Gate1Result | undefined {
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("RESULT_JSON:")) continue;
		try {
			const parsed = JSON.parse(trimmed.slice("RESULT_JSON:".length)) as {
				pass: boolean;
				steps: Array<{ index: number; ok: boolean; detail: string }>;
			};
			return { pass: parsed.pass, steps: parsed.steps };
		} catch {
			return undefined;
		}
	}
	return undefined;
}

// the timeout bounds RDKit reaction-enumeration combinatorial blow-ups
export function buildGate1SpawnOptions(cwd: string): { cwd: string; stdout: "pipe"; stderr: "pipe"; timeout: number } {
	return { cwd, stdout: "pipe", stderr: "pipe", timeout: 300_000 };
}

export async function runGate1(cwd: string, steps: ReactionStep[]): Promise<Gate1Result> {
	const parsed = steps.map((s) => ReactionStepSchema.parse(s));
	const env = await ensurePythonEnv({ cwd, name: "chem", requirements: ["rdkit"] });
	// a fixed filename races under concurrency (two calls running each other's script): name each call uniquely
	const scriptPath = join(env.path, `gate1-${randomUUID()}.py`);
	await Bun.write(scriptPath, buildGate1Script(parsed));
	try {
		const proc = Bun.spawn([env.python, scriptPath], buildGate1SpawnOptions(cwd));
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const result = parseGate1Output(stdout);
		if (!result) {
			return { pass: false, steps: [], error: `gate1 script failed (exit ${exitCode}): ${stderr.slice(-300)}` };
		}
		return result;
	} finally {
		try {
			await Bun.file(scriptPath).delete();
		} catch {
			// Cleanup failure does not affect the verdict; a leftover temp script inside the venv has no security impact
		}
	}
}
