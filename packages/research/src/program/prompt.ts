import { untrustedObjectiveBlock } from "@kea/core";
import { DEFAULT_PACK } from "./discipline.ts";
import { parkedNodes, premiseSet } from "./graph.ts";
import { recentLoadBearing } from "./ledger.ts";
import type { EpochFocus, PhaseDecision } from "./scheduler.ts";
import type { Program } from "./schema.ts";

// Round-prompt construction (pure string building — the only place round text is composed). Style
// contract: XML-wrap each round, state as labeled lines, JSON.stringify every dynamic value; state
// blocks carry ONE-LINE gists + a ledger pointer, never full texts; imperative sentences only, no
// editorializing; anti-abandonment as machine semantics with exclusions, never exhortation; every
// prohibition carries its replacement action; no honesty-terminal phrasing anywhere — the prompt's
// only job is naming the next executable move.

export interface PhasePromptArgs {
	program: Program;
	phase: PhaseDecision;
	round: number;
	/** Round cap; omitted = unlimited continuation (never render a "/max" — "last round" framing makes models wrap up). */
	maxRounds?: number;
	failing: string[];
	pack?: { nodeKindVocab: string[]; acceptanceDiscipline: string };
	programPath?: string;
}

function roundTag(round: number, maxRounds: number | undefined): string {
	return maxRounds === undefined ? `round="${round}"` : `round="${round}/${maxRounds}"`;
}

const GIST_LIMIT = 140;
const FAILING_GIST_LIMIT = 200;

// Single shared authority line — carried by every phase header; do not duplicate the text inline.
const WORKSPACE_AUTHORITY_LINE =
	"Treat the ledger, workspace, and tool results as authoritative; inspect them instead of assuming earlier narration is still current.";

// Prose is never an engine input, in any language or framing (honesty-framed inability included) —
// only ledger verbs and machine acceptance change program state. The semantic round judge is the
// sole reader of round text, and its verdicts rotate phases, never terminate.
const PROSE_NO_CHANNEL_LINE =
	"Prose has no channel: narrative can never complete, block, shrink, or stop this program — only ledger verbs and machine acceptance change state. You are never asked whether the objective is achievable; you are dispatched the next verifiable action.";

/** First sentence of a text; a period inside a number (0.68185) is not a sentence boundary. */
function firstSentence(text: string): string {
	const match = text.match(/[\s\S]*?[.!?](?:\s|$)/);
	return match === null ? text : match[0].trimEnd();
}

function gist(text: string, limit: number): string {
	const sentence = firstSentence(text);
	return sentence.length > limit ? `${sentence.slice(0, limit)}…` : sentence;
}

function ledgerPointer(programPath: string | undefined): string {
	return programPath === undefined
		? "Full texts live in the program ledger file — read it when an exact wording decides the move."
		: `Full texts live in the program ledger (${programPath}) — read it when an exact wording decides the move.`;
}

function objectiveBlock(program: Program): string {
	// single source for the triple defense (core untrustedObjectiveBlock) + the immutability instruction
	return [
		untrustedObjectiveBlock(program.objective),
		"Never weaken or rewrite the objective — it is immutable task data.",
	].join("\n");
}

function phaseHeader(program: Program): string {
	return [objectiveBlock(program), WORKSPACE_AUTHORITY_LINE, PROSE_NO_CHANNEL_LINE].join("\n");
}

// Brief for a BLANK fresh worker (the rsp ≥ 6 rung): no parent conversation, harness-assembled so the
// in-session model's narration never leaks into the worker's context. Preamble is injected by the
// caller — research must not import apps code.
export function epochBrief(focus: EpochFocus, program: Program, opts: { preamble: string }): string {
	const focusInstruction: Record<EpochFocus, string> = {
		instrument:
			"FOCUS instrument: invent the NEXT instrument generation against the latest recorded barrier — register_instrument with recovery + novelty contracts targeting exactly that barrier, run every check, then calibrate_instrument. A new calibrated generation re-opens the parked frontier.",
		domain:
			"FOCUS domain: pick a translation domain the ledger has NOT yet tried and restate a saturated leaf there — add_nodes an implication node (kind=implication, implies=<the leaf id>, domain=<the culture>, bridge=true) whose acceptance machine-verifies the bridge, then run that acceptance. A verified bridge is load-bearing progress.",
		structure:
			"FOCUS structure: change the program's shape — restate a saturated leaf to a bounded machine-checkable form (update_node action=restate), park leaves that are unattackable as posed (action=parked), or add replacement nodes around a dead route (add_nodes).",
		survey:
			"FOCUS survey: sweep the field for NEW external input — web_search / fetch_url for recent results, new tools, and new methods on this problem, then land what you find (add_nodes an imported node, or register_instrument a tool). A finding that is not recorded in the ledger did not happen.",
	};
	const seen = new Set<string>();
	const targets = [...premiseSet(program), ...parkedNodes(program)].filter((n) => {
		if (seen.has(n.id)) return false;
		seen.add(n.id);
		return true;
	});
	const targetLines =
		targets.length > 0
			? [
					"Saturated leaves (the open premise set plus the parked archive — attack one of them, or the structure around them):",
					...targets.map((n) => `- ${JSON.stringify(n.id)}: ${JSON.stringify(n.title)}`),
				].join("\n")
			: "Saturated leaves: none open — attack the program criteria directly or restructure toward them.";
	return [
		opts.preamble,
		`Immutable objective — never weaken or rewrite it:\n${untrustedObjectiveBlock(program.objective)}`,
		WORKSPACE_AUTHORITY_LINE,
		PROSE_NO_CHANNEL_LINE,
		"Do not call start_program — a program already exists; continue it.",
		focusInstruction[focus],
		targetLines,
		"Do not re-run searches or attempts the ledger already records. Do not restate a recorded barrier as a conclusion. Do not narrate difficulty — none of it is load-bearing.",
		"Record the work with update_node / add_nodes / register_instrument so the harness can credit it.",
	].join("\n");
}

function lineageBlock(program: Program, programPath: string | undefined): string {
	if (program.instruments.length === 0) return "(empty — you are building generation v1)";
	const lines = program.instruments.map((i) => {
		const [first] = i.recovers;
		const rest = i.recovers.length > 1 ? ` (+${i.recovers.length - 1} more)` : "";
		return `- ${i.id} v${i.version} [${i.status}] recovers: ${JSON.stringify(gist(first?.theorem ?? "", GIST_LIMIT))}${rest}`;
	});
	lines.push(ledgerPointer(programPath));
	return lines.join("\n");
}

function barriersBlock(program: Program, programPath: string | undefined): string {
	if (program.barriers.length === 0) return "";
	const lines = program.barriers.map((b) => {
		const check = b.check === undefined ? "" : ` [check: ${JSON.stringify(b.check.description)}]`;
		return `- on ${JSON.stringify(b.instrumentId)}: ${JSON.stringify(gist(b.statement, GIST_LIMIT))}${check}`;
	});
	lines.push(ledgerPointer(programPath));
	return lines.join("\n");
}

function skeletonBlock(program: Program): string {
	const premises = premiseSet(program);
	const parked = parkedNodes(program);
	const lines: string[] = [];
	if (premises.length > 0) {
		lines.push(
			`Premise set S (${premises.length} open leaves — proving one, weakening one via an implication edge, or merging two shrinks S; S empty ⟺ objective settled):`,
		);
		for (const p of premises) lines.push(`- ${JSON.stringify(p.id)}: ${JSON.stringify(p.title)}`);
	}
	if (parked.length > 0) {
		lines.push(`Parked frontier (re-opens automatically when a new generation calibrates):`);
		for (const p of parked) lines.push(`- ${JSON.stringify(p.id)}: ${JSON.stringify(p.title)}`);
	}
	return lines.join("\n");
}

function describeAcceptance(acceptance: Program["nodes"][number]["acceptance"]): string {
	if (acceptance.check === "command") {
		const expected =
			acceptance.expect_stdout_contains !== undefined
				? `, stdout contains ${JSON.stringify(acceptance.expect_stdout_contains)}`
				: "";
		return `command exits ${acceptance.expect_exit}${expected} — ${JSON.stringify(acceptance.command)}`;
	}
	const rel = acceptance.direction === "at_least" ? "≥" : "≤";
	return `command prints METRIC ${acceptance.metric} ${rel} ${acceptance.threshold} — ${JSON.stringify(acceptance.command)}`;
}

export function buildPhasePrompt(args: PhasePromptArgs): string {
	// `epoch` is never rendered here — epoch rounds have NO in-session prompt (the work goes to blank
	// fresh workers via epochBrief); both loops intercept phase.kind === "epoch" before calling this.
	const { program, phase, round, maxRounds, failing, programPath } = args;
	const pack = args.pack ?? DEFAULT_PACK;
	const head = `<invention_round ${roundTag(round, maxRounds)} phase="${phase.kind}">`;
	const tail = "</invention_round>";
	const lineage = `Instrument lineage:\n${lineageBlock(program, programPath)}`;
	const barriers = barriersBlock(program, programPath);
	const skeleton = skeletonBlock(program);
	const journalTail = recentLoadBearing(program, 5).map((e) => `- [r${e.round}] ${JSON.stringify(e.description)}`);
	const failingBlock =
		failing.length > 0
			? `Program criteria still failing:\n${[...failing.map((line) => gist(line, FAILING_GIST_LIMIT)), ledgerPointer(programPath)].join("\n")}`
			: "";

	if (phase.kind === "attack") {
		const { instrument, node } = phase;
		const declared = node.instrumentId === instrument.id;
		return [
			head,
			phaseHeader(program),
			lineage,
			barriers !== "" ? `Quantified barriers:\n${barriers}` : "",
			skeleton,
			journalTail.length > 0 ? `Last load-bearing work:\n${journalTail.join("\n")}` : "",
			"",
			`ATTACK with instrument ${JSON.stringify(instrument.id)} v${instrument.version}${declared ? " (the instrument this node declares)" : " (latest calibrated generation)"}: this round attacks exactly ONE node, using ONLY the instrument's primitives (do not import around it).`,
			`NODE ${JSON.stringify(node.id)} [${JSON.stringify(node.kind)}] — ${JSON.stringify(node.title)}`,
			`Statement: ${JSON.stringify(node.statement)}`,
			node.leanStatement !== undefined ? `Formal statement: ${JSON.stringify(node.leanStatement)}` : "",
			`Machine acceptance: ${describeAcceptance(node.acceptance)}`,
			node.dependsOn.length > 0
				? `Dependencies (proved, usable):\n${node.dependsOn.map((d) => `- ${JSON.stringify(d)}`).join("\n")}`
				: "",
			"",
			"Work the node to completion, run its machine acceptance, then update_node with the acceptance output as evidence.",
			"If the node as stated is wrong, refute it with evidence — the next round ANALYZEs the barrier and invents the next instrument.",
			"If the node is not wrong but is UNSATISFIABLE AS POSED for this generation (e.g. a finite search for an object that likely does not exist), PARK it (update_node action=parked with the reason) — parking shelves it for a future generation without falsifying anything; do not grind repeated searches.",
			"If the statement is provable only in a weaker bounded form, RESTATE it (update_node action=restate) to the bounded acceptance — a bounded theorem beats an abandoned node.",
			"If this instrument has NO lever on this node (wrong tool for the target), end your reply with the line INSTRUMENT_MISMATCH and stop — the engine re-pairs or ANALYZEs next round. Do not burn the round improvising around the wrong tool.",
			`Acceptance discipline: ${pack.acceptanceDiscipline}`,
			tail,
		]
			.filter((line) => line !== "")
			.join("\n");
	}

	if (phase.kind === "invent") {
		return [
			head,
			phaseHeader(program),
			lineage,
			barriers !== "" ? `Quantified barriers:\n${barriers}` : "",
			skeleton,
			failingBlock,
			"",
			`INVENT instrument v${phase.latestVersion + 1}${phase.reason === "frontier-drained" ? " (the attack frontier is drained — the next tool re-opens it)" : " (no calibrated instrument exists yet)"}. Invention has three equally valid forms:`,
			"1. A COMPUTATIONAL framework whose artifacts derive existing theorems when specialized.",
			"2. A FORMALIZED PRIMITIVE — a theorem the proof assistant lacks; its novelty check is a compiling zero-sorry proof of that theorem.",
			"3. A THEORY STRUCTURE — a new definition plus its first lemmas, added via add_nodes: every lemma is a machine-checkable theorem about the new object, and the object is chosen to give leverage on the premise set S above.",
			"",
			"Register via register_instrument (drafts are cheap — calibration is the commitment), run every check, then calibrate_instrument. Calibration is refused unless EVERY contract passes:",
			"1. RECOVERY — the framework derives a NAMED existing result as a special case (recovers[].check must pass; abstract re-encapsulation is refused). Recovery is the generality contract: a tool that only talks to this one problem is not a tool.",
			`2. NOVELTY — it does something the previous generation provably could not${phase.barriers.length > 0 ? " — transcend the latest barrier above" : ""} (novelty.check must pass; a METRIC contract counts).`,
			"3. ATTACKABILITY — attack rounds will use ONLY this instrument's primitives; keep them importable.",
			"",
			`Node kinds for this program: ${pack.nodeKindVocab.join(" / ")}.`,
			`Acceptance discipline: ${pack.acceptanceDiscipline}`,
			tail,
		]
			.filter((line) => line !== "")
			.join("\n");
	}

	if (phase.kind === "reform") {
		if (phase.mode === "translate") {
			const targets = phase.targets.map((n) => `- ${JSON.stringify(n.id)}: ${JSON.stringify(n.statement)}`).join("\n");
			return [
				head,
				phaseHeader(program),
				lineage,
				barriers !== "" ? `Quantified barriers:\n${barriers}` : "",
				`Saturated leaves this round must translate:\n${targets}`,
				failingBlock,
				"",
				"TRANSLATE (saturation level 2 — in-domain weakening failed, so cross domains). Restate a saturated leaf as a statement in a DIFFERENT domain and attack there — leverage historically comes from unrelated domains (Fermat→modularity, Poincaré→Ricci flow). Do not keep polishing the current formulation, do not run more in-domain searches, do not declare the leaf unattackable: a different domain is the replacement move.",
				"",
				"Execute with a BLIND fan-out: spawn_swarm with 3-4 items, one per mathematical culture (pick cultures that fit the leaf — e.g. spectral/operator theory, algebraic geometry, probability/random matrices, combinatorics/computation). Swarm agents must NOT see each other's proposals — diversity dies under premature convergence. Each item's prompt asks for ONE concrete translation proposal:",
				"- the external domain and its vocabulary (what objects live there)",
				"- the restated leaf P′ in that vocabulary",
				'- the BRIDGE: which implication must be proved for P′ ⟹ P (counterexample-to-pathology form: "an object violating P would be a pathological D′-object"; or equivalence form: "P ⟺ a natural D′ statement"), and the machine check that would verify the bridge (a Lean statement, a computation on concrete objects, a certificate)',
				"",
				"Then VERIFY with the machine gate, not debate: for the most promising proposal(s), add the bridge as an implication node via add_nodes (kind=implication, implies=<the saturated leaf's id>, domain=<the culture>, bridge=true) whose acceptance IS the bridge check, and run that acceptance. A verified bridge is load-bearing progress and re-opens the frontier in the new domain; decompose P′ there with ordinary nodes.",
				"Every rejected proposal must say WHY in one line (what the bridge check cannot certify) — rejections are context for the next proposal, not conclusions.",
				`Acceptance discipline: ${pack.acceptanceDiscipline}`,
				tail,
			]
				.filter((line) => line !== "")
				.join("\n");
		}
		return [
			head,
			phaseHeader(program),
			lineage,
			barriers !== "" ? `Quantified barriers:\n${barriers}` : "",
			skeleton,
			failingBlock,
			"",
			"REFORMULATE (saturation level 1 — the current formulation resists direct attack; change the formulation, which is always possible). Three directions, pick the sharpest:",
			'1. WEAKEN a premise: add_nodes an implication node (kind=implication, implies=<premise id>) whose statement is "H′ ⟹ H" with H′ strictly more tractable (computational, or attackable by an existing instrument); its acceptance machine-verifies the implication. Proving it shrinks the premise set — a real theorem whether or not H′ ever falls.',
			"2. NEW DEFINITION: add_nodes a definition node introducing an object built to have leverage on the saturated leaf, plus its first lemma with machine acceptance.",
			"3. GRANULARITY: restate the saturated leaf (update_node action=restate) to a bounded form the current tools can actually certify (a coverage metric, a verified-up-to-T statement, an explicit constant).",
			"",
			"Also available: PARK leaves that are principally unsatisfiable as posed (update_node action=parked) so the scheduler stops returning to them until a new generation calibrates, and HARVEST ready easy leaves (prove them) to bank load-bearing progress.",
			"Add at least one node or park at least one leaf this round; a narrative-only round counts as zero progress.",
			`Acceptance discipline: ${pack.acceptanceDiscipline}`,
			tail,
		]
			.filter((line) => line !== "")
			.join("\n");
	}

	if (phase.kind === "extend") {
		return [
			head,
			phaseHeader(program),
			lineage,
			barriers !== "" ? `Quantified barriers:\n${barriers}` : "",
			skeleton,
			failingBlock,
			"",
			"EXTEND the DAG. The next provable step is a MISSING LEMMA/THEOREM, not a new tool.",
			'"Weeks of work" / "large formalization" is a DECOMPOSITION signal, never a skip: a long proof is a DAG of small lemma nodes. Name the first 3 lemmas with machine acceptance (for the current domain, examples of the right granularity are the integral identities and kernel normalizations your acceptance commands already cite), add them via add_nodes, then prove lemma 1 and update_node.',
			"Formalizing a theorem the proof assistant lacks IS a valid primitive — register it as an instrument if reusable, otherwise prove it as a node.",
			"Start the first lemma this round. Do not re-decline because it is large.",
			tail,
		]
			.filter((line) => line !== "")
			.join("\n");
	}

	if (phase.kind === "replan") {
		const list = phase.unreachable
			.map((n) => `- ${JSON.stringify(n.id)} [${n.status}] ${JSON.stringify(n.title)}`)
			.join("\n");
		return [
			head,
			phaseHeader(program),
			lineage,
			barriers !== "" ? `Quantified barriers:\n${barriers}` : "",
			`Unreachable subtree (a dependency was refuted — mathematically dead, needs routing around):\n${list}`,
			failingBlock,
			"",
			"REPLAN: do not restart the refuted node; route around it. add_nodes replacement nodes that do not depend on the refuted result, each with machine acceptance, then work the first replacement. If the refutation reveals the whole route is dead, that is a TRANSLATION signal — restate the objective-critical leaf in a different domain (implication node with bridge=true).",
			tail,
		]
			.filter((line) => line !== "")
			.join("\n");
	}

	return [
		head,
		phaseHeader(program),
		lineage,
		barriers !== "" ? `Quantified barriers:\n${barriers}` : "",
		skeleton,
		failingBlock,
		"",
		"ANALYZE the frontier — the previous round hit the limit of the current approach. Difficulty, missing theory, or an unsolved field is not refusal and not blocked; it is exactly this phase's input. Do not stop and do not reroute to narration:",
		"1. State the barrier PRECISELY and quantitatively — what the current instrument cannot do, with the tightest bound you can justify.",
		"2. Record it with record_barrier INCLUDING its machine check where a computation can certify it — a barrier without a check is stored as a note and does not count as progress. An equivalent barrier already recorded needs no re-recording.",
		"3. Register the next instrument draft (register_instrument) whose recovery + novelty contracts target exactly this barrier. Registering the next generation is never fabrication — generation rotation is the mechanism itself; a worker who believes nothing more can be done still names the next most-credible draft.",
		"4. If the trigger was a pairing problem (INSTRUMENT_MISMATCH, a declared instrument that is not calibrated, or one instrument repeatedly failing to touch a node): fix the PAIRING — add a replacement node with the right instrumentId via add_nodes, register an instrument that has a lever on the stuck node, or park the node as unattackable by the whole lineage.",
		"5. If the route as posed is unsatisfiable (a finite search for a likely-nonexistent object, a condition the current theory cannot express): PARK the leaf (update_node action=parked) or RESTATE it to a bounded form — do not grind repeated searches, and do not refute a statement merely because it is currently unreachable (a refutation would falsely imply the route is dead).",
		"6. If every in-domain move is exhausted: REFORMULATE — weaken the premise via an implication node, or TRANSLATE the leaf into a different domain (kind=implication, bridge=true) and decompose it there.",
		"Producing at least one of these — a checked barrier, a draft, a node, a park, a restate — is the round's work; analysis prose alone counts as zero progress.",
		`Acceptance discipline: ${pack.acceptanceDiscipline}`,
		tail,
	]
		.filter((line) => line !== "")
		.join("\n");
}

// Back-compat alias for the math pack's acceptance discipline; new code passes a DisciplinePack.
export const ACCEPTANCE_DISCIPLINE = DEFAULT_PACK.acceptanceDiscipline;
