import { dependenciesSatisfied, nodeById, validateProgram } from "./graph.ts";
import type { JournalEntry, JournalKind, Program } from "./schema.ts";

// Pure state machine: every function returns a NEW Program (the input is never mutated) and appends
// the matching journal entry. Prove/refute do NOT run acceptance here — the caller must have run the
// machine acceptance (verify.ts) first, so "proved" in state always means machine-verified by the caller.

const updatedAt = (program: Program): Program => ({ ...program, updatedAt: Date.now() });

function entry(
	round: number,
	kind: JournalKind,
	description: string,
	evidence: string,
	nodeId?: string,
	instrumentId?: string,
): JournalEntry {
	return { round, kind, nodeId, instrumentId, description, evidence, at: Date.now() };
}

/** pending → active (context, NOT load-bearing — starting is not finishing). Parked nodes must be unparked first. */
export function startNode(program: Program, id: string, round: number, note = ""): Program {
	const node = nodeById(program, id);
	if (node === undefined) throw new Error(`unknown node "${id}"`);
	if (node.status === "proved") throw new Error(`node "${id}" is already proved`);
	if (node.status === "refuted") throw new Error(`node "${id}" is refuted; re-plan instead of restarting it`);
	if (node.status === "parked")
		throw new Error(
			`node "${id}" is parked; unpark it first (update_node action=unpark) — calibration also unparks automatically`,
		);
	if (!dependenciesSatisfied(program, node)) {
		throw new Error(`node "${id}" has unproved dependencies: [${node.dependsOn.join(", ")}]`);
	}
	return {
		...updatedAt(program),
		nodes: program.nodes.map((n) => (n.id === id ? { ...n, status: "active" as const } : n)),
		journal: [
			...program.journal,
			entry(round, "node_started", note || `started working on "${node.title}"`, "round start", id),
		],
	};
}

/** Preconditions of the proved transition (status + dependency checks); pure, throws on violation. */
export function assertProvable(program: Program, id: string): Program["nodes"][number] {
	const node = nodeById(program, id);
	if (node === undefined) throw new Error(`unknown node "${id}"`);
	if (node.status === "proved") throw new Error(`node "${id}" is already proved`);
	if (node.status === "refuted") throw new Error(`node "${id}" is refuted; re-plan instead of proving it`);
	if (!dependenciesSatisfied(program, node)) {
		throw new Error(`node "${id}" has unproved dependencies: [${node.dependsOn.join(", ")}]`);
	}
	return node;
}

export function proveNode(program: Program, id: string, round: number, evidence: string): Program {
	const node = assertProvable(program, id);
	return {
		...updatedAt(program),
		nodes: program.nodes.map((n) =>
			n.id === id ? { ...n, status: "proved" as const, evidence, parkedReason: undefined } : n,
		),
		journal: [...program.journal, entry(round, "node_proved", `proved "${node.title}"`, evidence, id)],
	};
}

/** → refuted (wrong as posed; dependents unreachable until re-planned). Idempotent: re-refuting is a no-op, never a fresh load-bearing entry. */
export function refuteNode(program: Program, id: string, round: number, evidence: string): Program {
	const node = nodeById(program, id);
	if (node === undefined) throw new Error(`unknown node "${id}"`);
	if (node.status === "proved") throw new Error(`node "${id}" is proved; it cannot be refuted afterwards`);
	if (node.status === "refuted") {
		return program;
	}
	return {
		...updatedAt(program),
		nodes: program.nodes.map((n) => (n.id === id ? { ...n, status: "refuted" as const, evidence } : n)),
		journal: [...program.journal, entry(round, "node_refuted", `refuted "${node.title}"`, evidence, id)],
	};
}

/** → parked: not attackable by the current generation, but nothing is dead — dependencies stay live; calibration unparks automatically. */
export function parkNode(program: Program, id: string, round: number, reason: string): Program {
	const node = nodeById(program, id);
	if (node === undefined) throw new Error(`unknown node "${id}"`);
	if (node.status === "parked") return program; // idempotent: no fresh load-bearing entry
	if (node.status === "refuted")
		throw new Error(
			`node "${id}" is refuted; parking would shelve a dead subtree — restate it instead (update_node action=restate)`,
		);
	if (node.status === "proved") throw new Error(`node "${id}" is proved; it cannot be parked`);
	return {
		...updatedAt(program),
		nodes: program.nodes.map((n) => (n.id === id ? { ...n, status: "parked" as const, parkedReason: reason } : n)),
		journal: [
			...program.journal,
			entry(round, "node_parked", `parked "${node.title}" — not attackable by the current generation`, reason, id),
		],
	};
}

export function unparkNode(program: Program, id: string, round: number): Program {
	const node = nodeById(program, id);
	if (node === undefined) throw new Error(`unknown node "${id}"`);
	if (node.status !== "parked") throw new Error(`node "${id}" is not parked`);
	return {
		...updatedAt(program),
		nodes: program.nodes.map((n) => (n.id === id ? { ...n, status: "pending" as const, parkedReason: undefined } : n)),
		journal: [...program.journal, entry(round, "note", `unparked "${node.title}"`, "frontier re-opened", id)],
	};
}

/** Restate to a bounded/satisfiable form: keeps the id and subtree, replaces statement/acceptance; load-bearing. */
export function restateNode(
	program: Program,
	id: string,
	round: number,
	next: {
		statement?: string;
		title?: string;
		acceptance?: Program["nodes"][number]["acceptance"];
		leanStatement?: string;
	},
): Program {
	const node = nodeById(program, id);
	if (node === undefined) throw new Error(`unknown node "${id}"`);
	if (node.status === "proved") throw new Error(`node "${id}" is proved; restate would falsify the ledger`);
	const restated = {
		...node,
		...(next.title !== undefined ? { title: next.title } : {}),
		...(next.statement !== undefined ? { statement: next.statement } : {}),
		...(next.leanStatement !== undefined ? { leanStatement: next.leanStatement } : {}),
		...(next.acceptance !== undefined ? { acceptance: next.acceptance } : {}),
		status: "pending" as const,
		parkedReason: undefined,
	};
	return {
		...updatedAt(program),
		nodes: program.nodes.map((n) => (n.id === id ? restated : n)),
		journal: [
			...program.journal,
			entry(
				round,
				"node_restated",
				`restated "${restated.title}" to a bounded form`,
				next.statement ?? node.statement,
				id,
			),
		],
	};
}

export function appendJournal(
	program: Program,
	round: number,
	kind: JournalKind,
	description: string,
	evidence: string,
	nodeId?: string,
): Program {
	if (nodeId !== undefined && nodeById(program, nodeId) === undefined) {
		throw new Error(`journal entry references unknown node "${nodeId}"`);
	}
	return {
		...updatedAt(program),
		journal: [...program.journal, entry(round, kind, description, evidence, nodeId)],
	};
}

/** Add nodes (re-planning / skeleton growth); validates the WHOLE graph after — malformed additions never persist. */
export function addNodes(program: Program, nodes: Program["nodes"], round: number): Program {
	const next: Program = {
		...updatedAt(program),
		nodes: [...program.nodes, ...nodes],
		journal: [
			...program.journal,
			entry(
				round,
				"nodes_added",
				`added ${nodes.length} node(s): ${nodes.map((n) => n.id).join(", ")}`,
				"skeleton growth",
			),
		],
	};
	const issues = validateProgram(next);
	if (issues.length > 0) {
		throw new Error(`invalid program graph: ${issues.map((i) => `${i.kind} (${i.detail})`).join("; ")}`);
	}
	return next;
}

/** draft → calibrated; the caller must have run every recovers + novelty check to passing first. */
export function calibrateInstrument(program: Program, instrumentId: string, round: number, evidence: string): Program {
	const instrument = program.instruments.find((i) => i.id === instrumentId);
	if (instrument === undefined) throw new Error(`unknown instrument "${instrumentId}"`);
	if (instrument.status === "calibrated") throw new Error(`instrument "${instrumentId}" is already calibrated`);
	if (instrument.status === "superseded")
		throw new Error(`instrument "${instrumentId}" is superseded; register a new generation instead`);
	// A new generation is the moment parked frontier nodes become attackable again — unpark them all.
	const unparked = program.nodes.map((n) =>
		n.status === "parked" ? { ...n, status: "pending" as const, parkedReason: undefined } : n,
	);
	const unparkNote = program.nodes.some((n) => n.status === "parked")
		? [
				entry(
					round,
					"note",
					`new generation "${instrument.id}" v${instrument.version}: unparked ${program.nodes.filter((n) => n.status === "parked").length} frontier node(s)`,
					"frontier re-opened by calibration",
				),
			]
		: [];
	const next: Program = {
		...updatedAt(program),
		nodes: unparked,
		instruments: program.instruments.map((i) =>
			i.id === instrumentId ? { ...i, status: "calibrated" as const, evidence } : i,
		),
		journal: [
			...program.journal,
			...unparkNote,
			entry(
				round,
				"instrument_calibrated",
				`calibrated instrument "${instrument.id}" v${instrument.version}`,
				evidence,
				undefined,
				instrument.id,
			),
		],
	};
	return next;
}

// Machine-gate discipline: invoke ONLY after checkProgram machine-evaluated every criterion to
// passing — "complete" stays a harness-verified fact, never a model self-declaration.
export function settleComplete(program: Program, round: number, evidence: string): Program {
	if (program.status === "complete") throw new Error("program is already complete");
	return {
		...updatedAt(program),
		status: "complete",
		journal: [
			...program.journal,
			entry(round, "program_completed", `program criteria all passed — settled complete`, evidence),
		],
	};
}

export function supersedeInstrument(program: Program, instrumentId: string, round: number, reason: string): Program {
	const instrument = program.instruments.find((i) => i.id === instrumentId);
	if (instrument === undefined) throw new Error(`unknown instrument "${instrumentId}"`);
	return {
		...updatedAt(program),
		instruments: program.instruments.map((i) => (i.id === instrumentId ? { ...i, status: "superseded" as const } : i)),
		journal: [...program.journal, entry(round, "note", `superseded instrument "${instrumentId}"`, reason)],
	};
}

/** Register an instrument draft (machine checks happen at calibration); recovers must name concrete existing theorems. */
export function registerInstrument(
	program: Program,
	instrument: Program["instruments"][number],
	round: number,
): Program {
	if (program.instruments.some((i) => i.id === instrument.id)) {
		throw new Error(`instrument id "${instrument.id}" already exists in the lineage`);
	}
	// a new instrument must be a strictly newer generation — flat/lower versions would farm
	// calibration entries as fake progress
	const maxVersion = program.instruments.reduce((m, i) => Math.max(m, i.version), 0);
	if (instrument.version <= maxVersion) {
		throw new Error(
			`instrument "${instrument.id}" v${instrument.version} is not a new generation (lineage is at v${maxVersion}); register v${maxVersion + 1}`,
		);
	}
	return {
		...updatedAt(program),
		instruments: [...program.instruments, instrument],
		journal: [
			...program.journal,
			entry(
				round,
				"note",
				`registered instrument "${instrument.id}" v${instrument.version} (draft)`,
				`${instrument.recovers.length} recovery contract(s)`,
			),
		],
	};
}

// Load-bearing ONLY when the barrier carries a machine check: a check-less barrier is recorded as a
// plain note — narrative obstructions are context, never progress.
export function recordBarrier(program: Program, barrier: Program["barriers"][number]): Program {
	const instrument = program.instruments.find((i) => i.id === barrier.instrumentId);
	if (instrument === undefined) throw new Error(`barrier references unknown instrument "${barrier.instrumentId}"`);
	// re-recording an equivalent barrier on the same instrument is a no-op, never a fresh entry
	const duplicate = program.barriers.some(
		(b) => b.instrumentId === barrier.instrumentId && b.statement.trim() === barrier.statement.trim(),
	);
	if (duplicate) return program;
	const checked = barrier.check !== undefined;
	return {
		...updatedAt(program),
		barriers: [...program.barriers, barrier],
		journal: [
			...program.journal,
			entry(
				barrier.round,
				checked ? "barrier_recorded" : "note",
				`barrier on "${barrier.instrumentId}": ${barrier.statement.slice(0, 160)}`,
				checked ? "machine-checked; see barriers[]" : "unchecked narrative barrier (not load-bearing)",
				undefined,
				barrier.instrumentId,
			),
		],
	};
}
