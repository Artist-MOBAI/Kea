import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core";
import { asTool, type SubagentRunner } from "@kea/core";
import { z } from "zod";
import { loadMobaiIn } from "./mobai.ts";
import {
	type Acceptance,
	addNodes,
	appendJournal,
	assertProvable,
	type Criterion,
	calibrateInstrument,
	DEFAULT_PACK,
	type DisciplinePack,
	InstrumentSchema,
	loadProgram,
	loadProgramStrict,
	type Program,
	ProgramSchema,
	parkNode,
	proveNode,
	recordBarrier,
	refuteNode,
	registerInstrument,
	restateNode,
	runAcceptance,
	saveProgram,
	startNode,
	supersedeInstrument,
	unparkNode,
	validateProgram,
} from "./program/index.ts";
import { runFidelityJudge } from "./program/judge.ts";

// Anti-self-declaration invariant: `update_node {action: "proved"}` runs the node's machine acceptance inside
// the tool and refuses the transition unless it passes — "proved" in the ledger is always a harness-verified fact.

export interface ProgramToolsContext {
	cwd: string;
	env: ExecutionEnv;
	/** Mobai storage directory (session-scoped in the TUI, workspace `.kea` headless); defaults to `<cwd>/.kea`. */
	mobaiDir?: () => string;
	/** Permission gate for acceptance/criterion commands (default = never execute, fail-closed). */
	reviewCommand?: (command: string) => "approve" | "deny" | "ask";
	/** Current round number stamped into journal entries (set by the loop; default 1 for interactive use). */
	currentRound?: () => number;
	pack?: DisciplinePack;
	/** Subagent runner for the formalization-fidelity judge (deferred getter, bound after kernel creation; absent = fail-open). */
	subagents?: () => SubagentRunner | undefined;
}

const programDirOf = (ctx: ProgramToolsContext): string => ctx.mobaiDir?.() ?? `${ctx.cwd}/.kea`;

const acceptanceParameters = z.discriminatedUnion("check", [
	z.strictObject({
		check: z.literal("command"),
		description: z.string(),
		command: z.string(),
		expect_exit: z.number().optional(),
		expect_stdout_contains: z.string().optional(),
	}),
	z.strictObject({
		check: z.literal("metric"),
		description: z.string(),
		command: z.string().meta({ description: "Must print `METRIC name=value` lines on stdout" }),
		metric: z.string(),
		direction: z.enum(["at_least", "at_most"]),
		threshold: z.number(),
	}),
]);

const nodeParameters = z.strictObject({
	id: z.string().meta({ description: "Unique node id (referenced by dependsOn)" }),
	kind: z
		.enum([
			"theorem",
			"lemma",
			"definition",
			"computation",
			"calibration",
			"experiment",
			"analysis",
			"artifact",
			"implication",
		])
		.meta({
			description:
				'Work-unit kind — framing only; scheduling depends on dependencies + acceptance. `implication` marks a skeleton edge: the node statement is "H′ ⟹ H" and `implies` names H',
		}),
	title: z.string().meta({ description: "Short title" }),
	statement: z.string().meta({ description: "Precise statement: what done means" }),
	leanStatement: z.string().optional().meta({ description: "Exact formal statement (documentation)" }),
	dependsOn: z.array(z.string()).optional().meta({ description: "Node ids that must be proved first" }),
	instrumentId: z.string().optional().meta({
		description:
			"Calibrated instrument this node should be attacked with (defaults to the latest generation; set it when a specific tool is the right one)",
	}),
	implies: z.string().optional().meta({
		description:
			'implication kind only: the premise node id this edge weakens (statement "H′ ⟹ H"); its acceptance must machine-verify the implication',
	}),
	domain: z.string().optional().meta({
		description:
			'Translation edges only: the external domain the premise lives in (e.g. "modular-forms", "random-matrices")',
	}),
	bridge: z.boolean().optional().meta({
		description: "Translation bridge marker: the premise comes from an external domain (the Frey-curve move)",
	}),
	imported: z
		.strictObject({
			source: z.string().meta({ description: "Where the imported theory comes from (paper/book id)" }),
			reference: z.string().meta({ description: "Precise reference (theorem number, section, equation)" }),
		})
		.optional(),
	acceptance: acceptanceParameters,
});

const criterionParameters = z.discriminatedUnion("check", [
	z.strictObject({
		check: z.literal("file_exists"),
		description: z.string(),
		path: z.string(),
	}),
	z.strictObject({
		check: z.literal("command"),
		description: z.string(),
		command: z.string(),
		expect_exit: z.number().optional(),
		expect_stdout_contains: z.string().optional(),
	}),
	z.strictObject({
		check: z.literal("metric_file"),
		description: z.string(),
		path: z.string(),
		metric: z.string(),
		direction: z.enum(["at_least", "at_most"]),
		threshold: z.number(),
	}),
]);

/** zod is the single parameter source: safeParse + prettifyError give the tool-call side its validation message. */
function parseParams<S extends z.ZodType>(schema: S, raw: unknown, what: string): z.output<S> {
	const result = schema.safeParse(raw);
	if (!result.success) throw new Error(`invalid ${what}: ${z.prettifyError(result.error)}`);
	return result.data;
}

function toCriterion(raw: unknown): Criterion {
	const parsed = parseParams(criterionParameters, raw, "criterion");
	if (parsed.check === "command") return { ...parsed, expect_exit: parsed.expect_exit ?? 0 };
	return parsed;
}

function toAcceptance(raw: unknown): Acceptance {
	const parsed = parseParams(acceptanceParameters, raw, "acceptance");
	if (parsed.check === "command") return { ...parsed, expect_exit: parsed.expect_exit ?? 0 };
	return parsed;
}

/** Shared node-params → ProgramNode mapping (start_program and add_nodes build nodes identically). */
function toProgramNode(raw: unknown): Record<string, unknown> {
	const n = parseParams(nodeParameters, raw, "node");
	return {
		id: n.id,
		kind: n.kind,
		title: n.title,
		statement: n.statement,
		leanStatement: n.leanStatement,
		dependsOn: n.dependsOn ?? [],
		instrumentId: n.instrumentId,
		implies: n.implies,
		domain: n.domain,
		bridge: n.bridge,
		imported: n.imported,
		acceptance: toAcceptance(n.acceptance),
	};
}

export function createProgramTools(ctx: ProgramToolsContext): AgentTool[] {
	const dir = () => programDirOf(ctx);
	const round = () => ctx.currentRound?.() ?? 1;
	const gate = (command: string) => ctx.reviewCommand?.(command) ?? "ask";

	// Refuse settled ledgers: a complete program is a closed book — mutations are refused so the
	// terminal stays a ledger fact; re-formalization via start_program (a new objective) is the only way forward.
	const loadActiveProgram = async (): Promise<Program> => {
		const program = await loadProgram(dir());
		if (!program) throw new Error("No program defined (start_program first).");
		if (program.status === "complete" || program.status === "exhausted") {
			throw new Error(`program is settled (${program.status}); start_program a new objective to re-formalize`);
		}
		return program;
	};

	const startProgramParameters = z.strictObject({
		objective: z.string(),
		criteria: z.array(criterionParameters).min(1),
		nodes: z.array(nodeParameters),
		discipline: z.enum(["math", "metric"]).optional().meta({
			description:
				'Domain discipline pack persisted with the program ("math" default): node vocabulary + acceptance discipline the round prompts re-read',
		}),
	});

	const startProgramTool = asTool({
		name: "start_program",
		label: "Start program",
		description:
			"Formalize an objective as a research program: a dependency DAG of machine-checkable nodes plus program-level completion criteria. Every node needs its OWN acceptance (a command exit contract, or a command printing METRIC lines). REFUSED while an unfinished program exists — continue it with update_node / add_nodes / program_note instead. An independent fresh-context reviewer verifies the formalization keeps the objective at full strength before the ledger is written.",
		parameters: z.toJSONSchema(startProgramParameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof startProgramParameters>) {
			// strict load: a corrupt ledger must throw naming the file — falling through to saveProgram
			// would silently overwrite it and destroy all journal/instrument history
			let existing: Program | undefined;
			try {
				existing = await loadProgramStrict(dir());
			} catch (err) {
				throw new Error(
					`${err instanceof Error ? err.message : String(err)} — inspect it or clear the scope manually (/mobai clear); refusing to overwrite`,
				);
			}
			// settled programs may be re-formalized: a settled ledger is a verdict on that skeleton, not a lock on the scope
			if (existing && existing.status !== "complete" && existing.status !== "exhausted") {
				throw new Error(
					"an unfinished program already exists in this scope; its criteria are immutable. Continue with update_node / add_nodes / program_note, or finish it first.",
				);
			}
			// mirror of start_goal's guard: an unsettled legacy mobai and a program must never coexist —
			// two ledgers means two completion gates and a zombie track
			const legacyMobai = await loadMobaiIn(dir());
			if (legacyMobai && legacyMobai.status !== "complete") {
				throw new Error(
					"an active legacy mobai exists in this scope; finish or clear it first (log_progress / update_goal / check_goal, or /mobai clear) before starting a program.",
				);
			}
			const pack = ctx.pack ?? DEFAULT_PACK;
			const program = ProgramSchema.parse({
				objective: params.objective,
				// creation-time anchor for the footer clock (updatedAt rewrites every round)
				startedAt: Date.now(),
				discipline: params.discipline,
				criteria: params.criteria.map((c) => toCriterion(c)),
				nodes: params.nodes.map(toProgramNode),
			});
			const issues = validateProgram(program);
			if (issues.length > 0) {
				throw new Error(`invalid program graph: ${issues.map((i) => `${i.kind} (${i.detail})`).join("; ")}`);
			}
			// Formalization-fidelity judge (semantic, language-independent): a fresh-context reviewer
			// verifies the nodes and criteria keep the objective at full strength before the ledger is
			// written. Absent or failed judge = fail-open (immutability + fail-closed criteria remain defenses).
			const judgeRunner = ctx.subagents?.();
			if (judgeRunner) {
				const verdict = await runFidelityJudge(judgeRunner, {
					objective: params.objective,
					roots: program.nodes
						.slice(0, 40)
						.map((n) => ({ id: n.id, title: n.title, statement: n.statement.slice(0, 200) })),
					criteria: program.criteria.map((c) => c.description),
				});
				if (verdict?.faithful === false) {
					throw new Error(
						`the program shrinks the objective (${verdict.shrinkment ?? "unfaithful formalization"}). State the full target in the root nodes and criteria; scope limits are decided by the user, not the settlement gate.`,
					);
				}
			}
			await saveProgram(dir(), program);
			return {
				content: [
					{
						type: "text",
						text: `Program set: ${program.objective} (${program.criteria.length} criteria, ${program.nodes.length} nodes; kinds: ${pack.nodeKindVocab.join("/")}).`,
					},
				],
				details: {},
			};
		},
	});

	const updateNodeParameters = z.strictObject({
		action: z.enum(["started", "proved", "refuted", "parked", "unparked", "restate"]),
		nodeId: z.string(),
		evidence: z.string().optional().meta({
			description:
				"For proved: the acceptance output. For refuted: the counterexample/reason. For parked: why this generation cannot attack it.",
		}),
		reason: z.string().optional().meta({
			description:
				"parked: why the CURRENT instrument generation cannot attack this node (nothing mathematically dead; a new calibration unparks it)",
		}),
		statement: z.string().optional().meta({ description: "restate: the new bounded statement" }),
		title: z.string().optional().meta({ description: "restate: new title" }),
		leanStatement: z.string().optional().meta({ description: "restate: new formal statement" }),
		acceptance: acceptanceParameters
			.optional()
			.meta({ description: "restate: new machine acceptance for the bounded form" }),
	});

	const updateNodeTool = asTool({
		name: "update_node",
		label: "Update node",
		description:
			'Transition a node: started | refuted | proved | parked | unparked | restate. "proved" runs the node\'s machine acceptance FIRST — the transition is REFUSED unless it passes; fix the work, not the acceptance. parked shelves the node for a future instrument generation — nothing mathematically dead (unlike refuted, no subtree dies); a new calibration unparks it automatically. restate replaces statement/acceptance with a bounded, satisfiable form (load-bearing progress). Use this instead of editing the program ledger (direct ledger writes are blocked).',
		parameters: z.toJSONSchema(updateNodeParameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof updateNodeParameters>) {
			const program = await loadActiveProgram();
			let next: Program;
			if (params.action === "started") {
				next = startNode(program, params.nodeId, round(), params.evidence ?? "");
			} else if (params.action === "refuted") {
				next = refuteNode(program, params.nodeId, round(), params.evidence ?? "");
			} else if (params.action === "parked") {
				if (!program.nodes.some((n) => n.id === params.nodeId)) throw new Error(`unknown node "${params.nodeId}"`);
				const reason = params.reason ?? params.evidence;
				if (reason === undefined || reason.trim() === "") {
					throw new Error('parking requires a reason ("reason"): why the current generation cannot attack this node.');
				}
				next = parkNode(program, params.nodeId, round(), reason);
			} else if (params.action === "unparked") {
				next = unparkNode(program, params.nodeId, round());
			} else if (params.action === "restate") {
				if (
					params.statement === undefined &&
					params.title === undefined &&
					params.leanStatement === undefined &&
					params.acceptance === undefined
				) {
					throw new Error("restate requires at least one of: statement, title, leanStatement, acceptance.");
				}
				next = restateNode(program, params.nodeId, round(), {
					statement: params.statement,
					title: params.title,
					leanStatement: params.leanStatement,
					acceptance: params.acceptance === undefined ? undefined : toAcceptance(params.acceptance),
				});
			} else {
				// Preconditions BEFORE the acceptance run: repeat-prove / dependency-missing calls must throw
				// without burning a full acceptance subprocess (up to the 1h ceiling) first.
				const node = assertProvable(program, params.nodeId);
				const acceptance = await runAcceptance(ctx.cwd, ctx.env, node.acceptance, gate);
				if (!acceptance.passed) {
					throw new Error(
						`machine acceptance for node "${params.nodeId}" FAILED (${acceptance.detail}) — the node stays unproved. Fix the work, not the acceptance.`,
					);
				}
				next = proveNode(program, params.nodeId, round(), `${acceptance.detail}; ${params.evidence ?? ""}`);
			}
			await saveProgram(dir(), next);
			return {
				content: [{ type: "text", text: `node "${params.nodeId}" → ${params.action}` }],
				details: {},
			};
		},
	});

	const addNodesParameters = z.strictObject({ nodes: z.array(nodeParameters).min(1) });

	const addNodesTool = asTool({
		name: "add_nodes",
		label: "Add nodes",
		description:
			"Re-plan: add replacement or refinement nodes to the program DAG. The whole graph is re-validated (no cycles, no unknown dependencies) before persisting — malformed additions are REFUSED, nothing reaches disk.",
		parameters: z.toJSONSchema(addNodesParameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof addNodesParameters>) {
			const program = await loadActiveProgram();
			const nodes = params.nodes.map(toProgramNode).map((n) => ({ ...n, status: "pending" as const }));
			const next = addNodes(program, ProgramSchema.shape.nodes.element.array().parse(nodes), round());
			await saveProgram(dir(), next);
			return { content: [{ type: "text", text: `added ${nodes.length} node(s)` }], details: {} };
		},
	});

	const programNoteParameters = z.strictObject({
		kind: z.enum(["note", "calibration"]),
		description: z.string(),
		evidence: z.string(),
		nodeId: z.string().optional(),
	});

	const noteTool = asTool({
		name: "program_note",
		label: "Program note",
		description:
			"Append a journal entry. With nodeId it is attached to that node's history; without nodeId it is program-level context. A note NEVER counts as progress — only node transitions (proved/refuted/parked/restated), added nodes, calibrated instruments, and checked barriers do.",
		parameters: z.toJSONSchema(programNoteParameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof programNoteParameters>) {
			const program = await loadActiveProgram();
			const next = appendJournal(program, round(), params.kind, params.description, params.evidence, params.nodeId);
			await saveProgram(dir(), next);
			return { content: [{ type: "text", text: "noted" }], details: {} };
		},
	});

	const registerInstrumentParameters = z.strictObject({
		id: z.string().meta({ description: "Instrument id, e.g. weighted-transfer" }),
		version: z.number().meta({ description: "Generation number (v1 = 1)" }),
		artifacts: z.array(z.string()).optional().meta({ description: "Workspace files constituting the framework" }),
		recovers: z
			.array(
				z.strictObject({
					theorem: z
						.string()
						.meta({ description: "NAMED existing theorem recovered as a special case (concrete, not abstract)" }),
					check: acceptanceParameters,
				}),
			)
			.min(1),
		novelty: z.strictObject({
			statement: z
				.string()
				.meta({ description: "New capability witness: what this generation can do that the previous could not" }),
			check: acceptanceParameters,
		}),
		supersedes: z.string().optional().meta({
			description:
				"Id of the instrument generation this one retires (kept in the lineage for provenance; no longer paired with nodes)",
		}),
	});

	const registerInstrumentTool = asTool({
		name: "register_instrument",
		label: "Register instrument",
		description:
			"Register a new instrument generation (draft). Invention becomes real only after calibrate_instrument machine-verifies EVERY recovery contract and the novelty witness — narration does not count. Pass `supersedes` to retire the generation this one replaces.",
		parameters: z.toJSONSchema(registerInstrumentParameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof registerInstrumentParameters>) {
			const program = await loadActiveProgram();
			const instrument = InstrumentSchema.parse({
				id: params.id,
				version: params.version,
				artifacts: params.artifacts ?? [],
				recovers: params.recovers.map((r) => ({
					theorem: r.theorem,
					check: toAcceptance(r.check),
				})),
				novelty: {
					statement: params.novelty.statement,
					check: toAcceptance(params.novelty.check),
				},
			});
			const next = registerInstrument(program, instrument, round());
			const withSuperseded =
				params.supersedes !== undefined && params.supersedes !== instrument.id
					? supersedeInstrument(
							next,
							params.supersedes,
							round(),
							`superseded by ${instrument.id} v${instrument.version}`,
						)
					: next;
			await saveProgram(dir(), withSuperseded);
			return {
				content: [
					{
						type: "text",
						text: `instrument "${instrument.id}" v${instrument.version} registered (draft) — run its checks, then calibrate_instrument${params.supersedes !== undefined ? `; superseded "${params.supersedes}"` : ""}`,
					},
				],
				details: {},
			};
		},
	});

	const calibrateInstrumentParameters = z.strictObject({ instrumentId: z.string() });

	const calibrateInstrumentTool = asTool({
		name: "calibrate_instrument",
		label: "Calibrate instrument",
		description:
			'Machine-verify an instrument: runs EVERY recovery check and the novelty check right now. Any failure REFUSES the calibration (the instrument stays draft) — fix the instrument, not the checks. "Invented" is a harness-verified fact, never a claim.',
		parameters: z.toJSONSchema(calibrateInstrumentParameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof calibrateInstrumentParameters>) {
			const program = await loadActiveProgram();
			const instrument = program.instruments.find((i) => i.id === params.instrumentId);
			if (!instrument) throw new Error(`unknown instrument "${params.instrumentId}"`);
			const failures: string[] = [];
			for (const recovery of instrument.recovers) {
				const result = await runAcceptance(ctx.cwd, ctx.env, recovery.check, gate);
				if (!result.passed) failures.push(`recovery "${recovery.theorem}": ${result.detail}`);
			}
			const novelty = await runAcceptance(ctx.cwd, ctx.env, instrument.novelty.check, gate);
			if (!novelty.passed) failures.push(`novelty: ${novelty.detail}`);
			if (failures.length > 0) {
				throw new Error(
					`calibration REFUSED — contracts failed: ${failures.join("; ")}. Fix the instrument (the work, not the checks).`,
				);
			}
			const next = calibrateInstrument(
				program,
				params.instrumentId,
				round(),
				[...instrument.recovers.map((r) => `${r.theorem}: pass`), `novelty: ${novelty.detail}`].join("; "),
			);
			await saveProgram(dir(), next);
			return {
				content: [
					{ type: "text", text: `instrument "${params.instrumentId}" calibrated — attack rounds may now use it` },
				],
				details: {},
			};
		},
	});

	const recordBarrierParameters = z.strictObject({
		instrumentId: z.string(),
		statement: z
			.string()
			.meta({ description: "Precise, quantified obstruction (what exactly this generation cannot do)" }),
		check: acceptanceParameters.optional(),
	});

	const recordBarrierTool = asTool({
		name: "record_barrier",
		label: "Record barrier",
		description:
			"Record why an instrument generation cannot reach the objective. WITH a machine check: verified now, load-bearing progress. WITHOUT a check: stored as a note that does NOT count as progress — machine-check the obstruction wherever a computation can certify it.",
		parameters: z.toJSONSchema(recordBarrierParameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof recordBarrierParameters>) {
			const program = await loadActiveProgram();
			if (params.check !== undefined) {
				const acceptance = toAcceptance(params.check);
				const result = await runAcceptance(ctx.cwd, ctx.env, acceptance, gate);
				if (!result.passed) {
					throw new Error(`barrier check FAILED (${result.detail}) — a recorded barrier must be a fact, not a claim.`);
				}
			}
			const next = recordBarrier(program, {
				instrumentId: params.instrumentId,
				statement: params.statement,
				check: params.check === undefined ? undefined : toAcceptance(params.check),
				round: round(),
			});
			await saveProgram(dir(), next);
			return { content: [{ type: "text", text: "barrier recorded" }], details: {} };
		},
	});

	return [
		startProgramTool,
		updateNodeTool,
		addNodesTool,
		noteTool,
		registerInstrumentTool,
		calibrateInstrumentTool,
		recordBarrierTool,
	];
}
