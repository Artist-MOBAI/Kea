import { untrustedObjectiveBlock } from "@kea/core";
import { DEFAULT_PACK, type DisciplinePack } from "@kea/research";

// Shared by TUI /mobai and the headless program loop. The opening line is pinned by core's
// FORMALIZE_PROMPT_PREFIX (isHarnessPromptText classifies formalize turns off it), and the objective
// must always flow through untrustedObjectiveBlock — never a bare interpolation.
export function programFormalizationPrompt(objective: string, pack: DisciplinePack = DEFAULT_PACK): string {
	return [
		"Formalize this into a machine-verifiable research program via start_program:",
		`Decompose the objective into a dependency DAG of machine-checkable nodes (${pack.nodeKindVocab.join(" / ")}).`,
		"Every node needs its OWN acceptance: a command exit contract, or a command printing METRIC lines. update_node enforces this — a proved node is a harness-verified fact.",
		pack.completionGateWording,
		pack.formalizeDecoration,
		untrustedObjectiveBlock(objective),
	].join("\n");
}
