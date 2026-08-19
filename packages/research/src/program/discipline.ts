// Discipline packs: the domain-neutral engine's domain-specific vocabulary and acceptance discipline.
// A pack supplies exactly (a) the decomposition vocabulary, (b) the anti-gaming acceptance discipline,
// and (c) the formalization prompt's completion-gate framing. The default math pack keeps every
// existing program's exact behavior.

export interface DisciplinePack {
	id: "math" | "metric";
	/** Anti-gaming acceptance discipline: appended to every ATTACK/INVENT round prompt. */
	acceptanceDiscipline: string;
	/** Node-kind vocabulary this domain decomposes into (framing only — scheduling ignores kind). */
	nodeKindVocab: string[];
	formalizeDecoration: string;
	completionGateWording: string;
}

export const mathPack: DisciplinePack = {
	id: "math",
	acceptanceDiscipline: [
		"Theorem-existence checks must grep the FULL statement line (with the concrete object names), never just the theorem name.",
		"Statements must reference the CONCRETE mathematical object (e.g. riemannZeta / the actual function under study); abstract re-encapsulation does not count.",
		"For Lean: verify `#print axioms <theorem>` shows no extra axioms, and the project has zero sorry/admit.",
	].join(" "),
	nodeKindVocab: ["theorem", "lemma", "definition", "computation", "calibration"],
	completionGateWording:
		"Program criteria must be the real completion gate (a formal proof, a command, or a metric contract), never a survey or a subset.",
	formalizeDecoration: [
		"Prefer formal (Lean/Coq) statements with their own machine acceptance; node kinds: theorem / lemma / definition / computation / calibration.",
	].join(" "),
};

// Empirical/metric discipline: the gate is measurement, not proof.
export const metricPack: DisciplinePack = {
	id: "metric",
	acceptanceDiscipline: [
		"Metric acceptances must run a held-out or known-answer gate the harness can rerun: report the command, not just the number.",
		"A single run is not evidence: confirm with multiple seeds and report the variance (the METRIC contract carries it).",
		"Include a negative control where one exists (a baseline the method must beat, or an input it must fail on) — passing it is part of acceptance.",
		"Never evaluate on data the candidate was tuned on; name the split in the acceptance command.",
	].join(" "),
	nodeKindVocab: ["experiment", "analysis", "computation", "calibration", "artifact"],
	completionGateWording:
		"Program criteria must be the real completion gate (a leaderboard metric, a held-out evaluation command, or a reproduction check), never a survey or a subset.",
	formalizeDecoration: [
		"Decompose into experiments / analyses / computations, each with its own machine acceptance; keep baselines and seeds explicit.",
	].join(" "),
};

export const DEFAULT_PACK: DisciplinePack = mathPack;

export function packById(id: string | undefined): DisciplinePack {
	return id === "metric" ? metricPack : mathPack;
}
