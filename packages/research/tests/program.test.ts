import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionEnv } from "@kea/core";
import { afterAll, describe, expect, test } from "vitest";
import {
	addNodes,
	appendJournal,
	calibrateInstrument,
	determinePhase,
	downstreamDepth,
	InstrumentSchema,
	lastLoadBearingIndex,
	loadBearingSince,
	loadProgram,
	loadProgramStrict,
	type Program,
	type ProgramNode,
	ProgramSchema,
	parkedNodes,
	parkNode,
	pickNext,
	premiseSet,
	proveNode,
	readyNodes,
	recordBarrier,
	refuteNode,
	registerInstrument,
	restateNode,
	runAcceptance,
	saveProgram,
	startNode,
	unparkNode,
	unreachableNodes,
	validateProgram,
} from "../src/program/index.ts";

let workdir: string;
afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

const cmd = (description: string, command: string): ProgramNode["acceptance"] => ({
	check: "command",
	description,
	command,
	expect_exit: 0,
});

function node(id: string, dependsOn: string[] = [], extra: Partial<ProgramNode> = {}): ProgramNode {
	return ProgramSchema.shape.nodes.element.parse({
		id,
		kind: "lemma",
		title: `node ${id}`,
		statement: `statement of ${id}`,
		dependsOn,
		acceptance: cmd(`acceptance ${id}`, "true"),
		...extra,
	});
}

function program(nodes: ProgramNode[]): Program {
	return ProgramSchema.parse({
		objective: "test program",
		criteria: [{ check: "command", description: "final", command: "true", expect_exit: 0 }],
		nodes,
	});
}

describe("program schema", () => {
	test("defaults parse: journal empty, statuses pending, dependsOn []", () => {
		const p = program([node("a")]);
		expect(p.journal).toEqual([]);
		expect(p.nodes[0]?.status).toBe("pending");
		expect(p.nodes[0]?.dependsOn).toEqual([]);
		expect(p.status).toBe("active");
	});

	test("startedAt optional: pre-field ledgers parse without it; set values round-trip", () => {
		const legacy = program([node("a")]);
		expect(legacy.startedAt).toBeUndefined();
		const stamped = ProgramSchema.parse({ ...program([node("a")]), startedAt: 1234 });
		expect(stamped.startedAt).toBe(1234);
	});

	test("acceptance is a discriminated union (command | metric)", () => {
		const metric = ProgramSchema.shape.nodes.element.shape.acceptance.parse({
			check: "metric",
			description: "proportion",
			command: "python3 eval.py",
			metric: "proportion",
			direction: "at_least",
			threshold: 0.6725,
		});
		expect(metric.check).toBe("metric");
	});
});

describe("validateProgram (DAG invariants)", () => {
	test("cycle rejected", () => {
		const issues = validateProgram(program([node("a", ["b"]), node("b", ["a"])]));
		expect(issues.some((i) => i.kind === "cycle")).toBe(true);
	});

	test("unknown dependency and duplicate id rejected", () => {
		const issues = validateProgram(program([node("a", ["ghost"]), node("a")]));
		expect(issues.some((i) => i.kind === "unknown-dependency")).toBe(true);
		expect(issues.some((i) => i.kind === "duplicate-id")).toBe(true);
	});

	test("self-dependency rejected", () => {
		expect(validateProgram(program([node("a", ["a"])])).some((i) => i.kind === "self-dependency")).toBe(true);
	});

	test("well-formed chain passes", () => {
		expect(validateProgram(program([node("a"), node("b", ["a"]), node("c", ["b"])]))).toEqual([]);
	});
});

describe("graph queries", () => {
	test("readyNodes gates on proved dependencies", () => {
		const p0 = program([node("a"), node("b", ["a"])]);
		expect(readyNodes(p0).map((n) => n.id)).toEqual(["a"]);
		const p1 = proveNode(p0, "a", 1, "acceptance exit=0");
		expect(readyNodes(p1).map((n) => n.id)).toEqual(["b"]);
	});

	test("downstreamDepth measures the longest unproved chain", () => {
		const p = program([node("root"), node("l1", ["root"]), node("l2", ["root"]), node("d", ["l1"])]);
		expect(downstreamDepth(p, "root")).toBe(2);
		const proved = proveNode(proveNode(proveNode(p, "root", 1, "e"), "l1", 2, "e"), "d", 3, "e");
		expect(downstreamDepth(proved, "root")).toBe(1);
	});

	// the depth must take the longest branch even when a shared node is also reachable via a shorter branch
	// (a shared visited set would cut mid's subtree to 0 on the second visit)
	test("downstreamDepth does not undercount diamonds via a shared visited set (audit P2#6)", () => {
		const p = program([
			node("root"),
			node("x", ["root"]),
			node("w", ["root"]),
			node("mid", ["w", "root"]), // diamond: reachable via root directly AND via w
			node("y", ["mid"]),
			node("z", ["y"]),
		]);
		expect(downstreamDepth(p, "root")).toBe(4);
	});
});

describe("transitions (pure state machine)", () => {
	test("prove with unproved dependencies throws", () => {
		const p = program([node("a"), node("b", ["a"])]);
		expect(() => proveNode(p, "b", 1, "e")).toThrow(/unproved dependencies/);
	});

	test("prove records evidence + journal and unlocks dependents (input immutable)", () => {
		const p0 = program([node("a"), node("b", ["a"])]);
		const p1 = proveNode(p0, "a", 3, "acceptance exit=0");
		expect(p0.nodes[0]?.status).toBe("pending");
		expect(p1.nodes[0]?.status).toBe("proved");
		expect(p1.nodes[0]?.evidence).toContain("exit=0");
		expect(p1.journal.at(-1)).toMatchObject({ kind: "node_proved", nodeId: "a", round: 3 });
		expect(readyNodes(p1).map((n) => n.id)).toEqual(["b"]);
	});

	test("refute makes dependents unreachable; double-settle throws", () => {
		const p0 = program([node("a"), node("b", ["a"])]);
		const p1 = refuteNode(p0, "a", 1, "counterexample");
		expect(() => proveNode(p1, "b", 2, "e")).toThrow(/unproved dependencies/);
		expect(() => proveNode(refuteNode(p0, "a", 1, "e"), "a", 2, "e")).toThrow(/refuted/);
	});

	test("startNode requires ready node; appendJournal validates nodeId", () => {
		const p0 = program([node("a"), node("b", ["a"])]);
		expect(() => startNode(p0, "b", 1)).toThrow(/unproved dependencies/);
		const p1 = startNode(p0, "a", 1);
		expect(p1.nodes[0]?.status).toBe("active");
		expect(() => appendJournal(p0, 1, "note", "x", "y", "ghost")).toThrow(/unknown node/);
	});

	test("addNodes validates the whole graph and rejects cycles", () => {
		const p = program([node("a")]);
		expect(() => addNodes(p, [node("b", ["c"]), node("c", ["b"])], 1)).toThrow(/invalid program graph/);
		const ok = addNodes(p, [node("b", ["a"])], 1);
		expect(ok.nodes.map((n) => n.id)).toEqual(["a", "b"]);
	});
});

describe("scheduler (critical-path first)", () => {
	test("picks the ready node with the longest downstream chain", () => {
		const p = program([node("side"), node("spine"), node("s1", ["spine"]), node("s2", ["s1"])]);
		const decision = pickNext(p);
		expect(decision.kind).toBe("node");
		if (decision.kind === "node") expect(decision.node.id).toBe("spine");
	});

	test("blocked reports the unreachable subtree after a refuted dependency", () => {
		const p0 = program([node("a"), node("b", ["a"]), node("free")]);
		const p1 = refuteNode(p0, "a", 1, "counterexample");
		const decision = pickNext(p1);
		// "free" is still ready → node round first; refute it too, then only the dead subtree remains
		expect(decision.kind).toBe("node");
		const p2 = refuteNode(p1, "free", 2, "not applicable");
		const decision2 = pickNext(p2);
		expect(decision2.kind).toBe("blocked");
		if (decision2.kind === "blocked") expect(decision2.unreachable.map((n) => n.id)).toContain("b");
	});

	test("empty when every node is settled", () => {
		const p = proveNode(program([node("a")]), "a", 1, "e");
		expect(pickNext(p).kind).toBe("empty");
	});
});

describe("ledger (load-bearing accounting — closed op-kind set)", () => {
	test("narration is never progress: note/calibration/node_started are not load-bearing", () => {
		let p = program([node("a")]);
		p = appendJournal(p, 1, "calibration", "survey", "no node");
		p = startNode(p, "a", 2); // starting is not finishing
		p = appendJournal(p, 2, "note", "searched 125 boxes, no counterexample", "narration", "a");
		expect(loadBearingSince(p)).toBe(0);
		expect(lastLoadBearingIndex(p)).toBe(-1);
		p = proveNode(p, "a", 3, "exit=0");
		expect(loadBearingSince(p)).toBe(1);
		expect(loadBearingSince(p, 0)).toBe(1);
	});

	test("structural ops are load-bearing: nodes_added / node_parked / node_restated", () => {
		let p = program([node("a"), node("b", ["a"])]);
		const lastKind = (): string | undefined => p.journal.at(-1)?.kind;
		p = addNodes(p, [node("c")], 1);
		expect(lastKind()).toBe("nodes_added");
		p = parkNode(p, "a", 2, "finite search for a nonexistent object");
		expect(lastKind()).toBe("node_parked");
		p = restateNode(p, "b", 3, { statement: "bounded form", title: "b (bounded)" });
		expect(lastKind()).toBe("node_restated");
		expect(loadBearingSince(p)).toBe(3);
	});
});

describe("transitions: park / unpark / restate (translation-skeleton engine)", () => {
	test("park shelves without subtree death: parked stays out of ready AND unreachable", () => {
		let p = program([node("a"), node("b", ["a"]), node("free")]);
		p = parkNode(p, "a", 1, "no lever in this generation");
		expect(p.nodes[0]?.status).toBe("parked");
		expect(p.nodes[0]?.parkedReason).toBe("no lever in this generation");
		expect(readyNodes(p).map((n) => n.id)).toEqual(["free"]); // b blocked, a parked
		expect(unreachableNodes(p)).toEqual([]); // park ≠ refute: nothing mathematically dead
		// a direct prove still settles a parked node (real work beats the archive label)
		p = proveNode(p, "a", 2, "found a lever after all");
		expect(p.nodes[0]?.status).toBe("proved");
	});

	test("park is idempotent — no fresh load-bearing entry", () => {
		const p0 = program([node("a")]);
		const p1 = parkNode(p0, "a", 1, "r");
		const p2 = parkNode(p1, "a", 2, "r again");
		expect(p2).toBe(p1);
		expect(p2.journal.filter((e) => e.kind === "node_parked")).toHaveLength(1);
	});

	test("unpark re-opens the frontier; calibrate auto-unparks the whole archive (Go-Explore return)", () => {
		let p = program([node("a"), node("b")]);
		p = parkNode(p, "a", 1, "waiting for a new generation");
		p = parkNode(p, "b", 1, "waiting for a new generation");
		p = unparkNode(p, "a", 2);
		expect(p.nodes[0]?.status).toBe("pending");
		expect(p.nodes[0]?.parkedReason).toBeUndefined();
		expect(parkedNodes(p).map((n) => n.id)).toEqual(["b"]);

		const draft = InstrumentSchema.parse({
			id: "tool-v2",
			version: 2,
			artifacts: [],
			recovers: [{ theorem: "T", check: { check: "command", description: "d", command: "true", expect_exit: 0 } }],
			novelty: { statement: "n", check: { check: "command", description: "d", command: "true", expect_exit: 0 } },
		});
		p = registerInstrument(p, draft, 2);
		p = calibrateInstrument(p, "tool-v2", 3, "all checks pass");
		expect(parkedNodes(p)).toEqual([]); // calibration is the "first return" moment
		expect(p.nodes.every((n) => n.status === "pending")).toBe(true);
	});

	test("restate keeps id + subtree, replaces statement/acceptance, resets to pending (load-bearing)", () => {
		const p0 = program([node("a"), node("b", ["a"])]);
		const bounded = { ...cmd("bounded acceptance", "test 1 -lt 3000"), description: "bounded acceptance" };
		const p1 = restateNode(p0, "a", 4, {
			statement: "verified for height < 3000",
			acceptance: bounded,
		});
		expect(p1.nodes[0]?.status).toBe("pending");
		expect(p1.nodes[0]?.statement).toBe("verified for height < 3000");
		expect(p1.nodes[0]?.acceptance.description).toBe("bounded acceptance");
		expect(p1.nodes[0]?.dependsOn).toEqual([]);
		expect(p1.nodes.map((n) => n.id)).toEqual(["a", "b"]); // id + subtree preserved
		expect(p1.journal.at(-1)).toMatchObject({ kind: "node_restated", nodeId: "a", round: 4 });
		expect(() => restateNode(proveNode(p1, "a", 5, "e"), "a", 6, { statement: "x" })).toThrow(/proved/);
	});

	test("restate on a parked node re-opens it (bounded form of a shelved statement)", () => {
		let p = program([node("a")]);
		p = parkNode(p, "a", 1, "unsatisfiable as posed");
		p = restateNode(p, "a", 2, { statement: "bounded form" });
		expect(p.nodes[0]?.status).toBe("pending");
		expect(p.nodes[0]?.parkedReason).toBeUndefined();
	});

	test("park on a refuted node throws — parking must not revive a dead subtree (restate is the channel)", () => {
		const refuted = refuteNode(program([node("a")]), "a", 1, "counterexample");
		expect(() => parkNode(refuted, "a", 2, "shelve it")).toThrow(/refuted.*restate/);
	});
});

describe("pump seals: refute / barrier idempotence (no fake progress from re-records)", () => {
	test("re-refuting an already-refuted node is a no-op (same reference, no new entry)", () => {
		const p0 = program([node("a")]);
		const p1 = refuteNode(p0, "a", 1, "counterexample");
		const p2 = refuteNode(p1, "a", 2, "same counterexample again");
		expect(p2).toBe(p1);
		expect(p2.journal.filter((e) => e.kind === "node_refuted")).toHaveLength(1);
		expect(loadBearingSince(p2)).toBe(1);
	});

	test("equivalent barrier re-record is a no-op; unchecked barriers are notes, checked are load-bearing", () => {
		const draft = InstrumentSchema.parse({
			id: "tool",
			version: 1,
			artifacts: [],
			recovers: [{ theorem: "T", check: { check: "command", description: "d", command: "true", expect_exit: 0 } }],
			novelty: { statement: "n", check: { check: "command", description: "d", command: "true", expect_exit: 0 } },
		});
		let p = registerInstrument(program([]), draft, 1);
		p = recordBarrier(p, { instrumentId: "tool", statement: "some narrative hunch", round: 1 });
		expect(p.journal.at(-1)?.kind).toBe("note"); // no check → narrative context, never progress
		p = recordBarrier(p, {
			instrumentId: "tool",
			statement: "bandwidth ≤ 1 caps at 0.68",
			round: 2,
			check: { check: "command", description: "certificate", command: "true", expect_exit: 0 },
		});
		expect(p.journal.at(-1)?.kind).toBe("barrier_recorded");
		const before = p.journal.length;
		p = recordBarrier(p, {
			instrumentId: "tool",
			statement: "  bandwidth ≤ 1 caps at 0.68  ", // whitespace-trimmed equivalent
			round: 3,
			check: { check: "command", description: "certificate", command: "true", expect_exit: 0 },
		});
		expect(p.journal.length).toBe(before); // duplicate → no fresh load-bearing entry
	});

	test("calibration/barrier entries are stamped with the instrument id (per-target attribution)", () => {
		const draft = InstrumentSchema.parse({
			id: "tool-v9",
			version: 9,
			artifacts: [],
			recovers: [{ theorem: "T", check: { check: "command", description: "d", command: "true", expect_exit: 0 } }],
			novelty: { statement: "n", check: { check: "command", description: "d", command: "true", expect_exit: 0 } },
		});
		let p = registerInstrument(program([]), draft, 1);
		p = calibrateInstrument(p, "tool-v9", 2, "all checks pass");
		expect(p.journal.at(-1)).toMatchObject({ kind: "instrument_calibrated", instrumentId: "tool-v9" });
		p = recordBarrier(p, {
			instrumentId: "tool-v9",
			statement: "bandwidth ceiling at 0.68",
			round: 3,
			check: { check: "command", description: "certificate", command: "true", expect_exit: 0 },
		});
		expect(p.journal.at(-1)).toMatchObject({ kind: "barrier_recorded", instrumentId: "tool-v9" });
	});
});

describe("instrument lineage monotonicity (audit #8)", () => {
	const draft = (id: string, version: number) =>
		InstrumentSchema.parse({
			id,
			version,
			artifacts: [],
			recovers: [{ theorem: "T", check: { check: "command", description: "d", command: "true", expect_exit: 0 } }],
			novelty: { statement: "n", check: { check: "command", description: "d", command: "true", expect_exit: 0 } },
		});

	test("flat/lower version refused; duplicate id refused", () => {
		let p = registerInstrument(program([]), draft("gen", 2), 1);
		expect(() => registerInstrument(p, draft("gen-flat", 2), 2)).toThrow(/not a new generation.*v3/);
		expect(() => registerInstrument(p, draft("gen-lower", 1), 2)).toThrow(/not a new generation.*v3/);
		expect(() => registerInstrument(p, draft("gen", 3), 2)).toThrow(/already exists/); // id gate first
		p = registerInstrument(p, draft("gen3", 3), 2);
		expect(p.instruments.map((i) => `${i.id}@${i.version}`)).toEqual(["gen@2", "gen3@3"]);
	});
});

describe("epoch generation rounds (rsp ≥ 6: blank-worker phase, no terminal)", () => {
	const instrument = (id: string, version: number) =>
		InstrumentSchema.parse({
			id,
			version,
			artifacts: [],
			recovers: [{ theorem: "T", check: { check: "command", description: "d", command: "true", expect_exit: 0 } }],
			novelty: { statement: "n", check: { check: "command", description: "d", command: "true", expect_exit: 0 } },
			status: "calibrated",
		});
	// root + open leaves: the premise set is non-empty so attack phases (not invent) would win at L0
	const epochProg = (extra: ProgramNode[] = [], parkedId?: string): Program => {
		const leaves = [node("leaf1", ["root"]), node("leaf2", ["root"]), ...extra];
		let p: Program = { ...program([node("root"), ...leaves]), instruments: [instrument("i", 1)] };
		if (parkedId !== undefined) p = parkNode(p, parkedId, 1, "unattackable as posed");
		return p;
	};

	test("rsp 6/7/8 → epoch with the focus rotating across axes (instrument/domain/structure)", () => {
		const p = epochProg();
		for (const [rsp, focus] of [
			[6, "instrument"],
			[7, "domain"],
			[8, "structure"],
		] as const) {
			const phase = determinePhase(p, false, rsp);
			expect(phase).toMatchObject({ kind: "epoch", saturation: 3 });
			if (phase.kind === "epoch") expect(phase.focuses).toEqual([focus]);
		}
	});

	test("rsp 12 → 2 distinct focuses; rsp 18/19/25 → 3 distinct focuses (sampling widens with stagnation)", () => {
		const p = epochProg();
		const two = determinePhase(p, false, 12);
		expect(two).toMatchObject({ kind: "epoch" });
		if (two.kind === "epoch") {
			expect(two.focuses).toHaveLength(2);
			expect(new Set(two.focuses).size).toBe(2);
		}
		for (const rsp of [18, 19, 25]) {
			const three = determinePhase(p, false, rsp);
			expect(three).toMatchObject({ kind: "epoch" });
			if (three.kind === "epoch") {
				expect(three.focuses).toHaveLength(3);
				expect(new Set(three.focuses).size).toBe(3);
			}
		}
	});

	test("targets = premiseSet + parked, deduped; analysisDue does not preempt epoch (saturation beats breakers)", () => {
		const p = epochProg([node("parked-leaf", ["root"])], "parked-leaf");
		const phase = determinePhase(p, true, 6);
		expect(phase).toMatchObject({ kind: "epoch", saturation: 3 });
		if (phase.kind === "epoch") {
			const ids = phase.targets.map((n) => n.id);
			expect(ids).toContain("leaf1");
			expect(ids).toContain("parked-leaf");
			expect(new Set(ids).size).toBe(ids.length);
		}
	});

	test("legacy exhausted ledgers still parse (exhausted is read-only legacy; no production path sets it)", () => {
		const legacy = ProgramSchema.parse({ ...program([node("a")]), status: "exhausted" });
		expect(legacy.status).toBe("exhausted");
	});
});

describe("premiseSet (S-shrink metric of the conditional skeleton)", () => {
	test("open leaves the root depends on; proving a leaf removes it", () => {
		// root is consumed by leaf1/leaf2 (the open statements to discharge are the leaves)
		let p = program([node("root"), node("leaf1", ["root"]), node("leaf2", ["root"])]);
		expect(premiseSet(p).map((n) => n.id)).toEqual(["leaf1", "leaf2"]);
		p = proveNode(p, "root", 1, "e");
		expect(premiseSet(p).map((n) => n.id)).toEqual(["leaf1", "leaf2"]); // proved root never re-enters S
		p = proveNode(p, "leaf1", 2, "e");
		expect(premiseSet(p).map((n) => n.id)).toEqual(["leaf2"]);
	});

	test("a PROVED implication H′⟹leaf1 replaces leaf1 in S (pending bridges cover nothing)", () => {
		let p = program([node("root"), node("leaf1", ["root"]), node("leaf2", ["root"])]);
		const implication: ProgramNode = ProgramSchema.shape.nodes.element.parse({
			id: "weaker-implies-leaf1",
			kind: "implication",
			title: "H′ ⟹ leaf1",
			statement: "H′ implies leaf1",
			dependsOn: [],
			implies: "leaf1",
			acceptance: cmd("implication check", "true"),
		});
		p = addNodes(p, [implication], 1);
		// pending bridge: leaf1 is still the working premise (plus the open bridge itself)
		const pending = premiseSet(p).map((n) => n.id);
		expect(pending).toContain("leaf1");
		expect(pending).toContain("weaker-implies-leaf1");
		p = proveNode(p, "weaker-implies-leaf1", 2, "bridge verified");
		expect(premiseSet(p).map((n) => n.id)).toEqual(["leaf2"]); // leaf1 discharged, replaced by H′
	});

	test("parked nodes stay in S (the archive is remembered frontier, not forgotten)", () => {
		let p = program([node("root"), node("leaf1", ["root"]), node("leaf2", ["root"])]);
		p = parkNode(p, "leaf1", 1, "unattackable this generation");
		expect(premiseSet(p).map((n) => n.id)).toEqual(["leaf1", "leaf2"]);
	});
});

describe("verify (machine acceptance)", () => {
	test("command acceptance passes and fails on exit code", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-program-"));
		const { env } = await createExecutionEnv(workdir);
		const ok = await runAcceptance(workdir, env, cmd("true", "true"), () => "approve");
		expect(ok.passed).toBe(true);
		const bad = await runAcceptance(workdir, env, cmd("false", "false"), () => "approve");
		expect(bad.passed).toBe(false);
	});

	test("metric acceptance parses METRIC stdout and applies the threshold", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-program-"));
		const { env } = await createExecutionEnv(workdir);
		const acceptance: ProgramNode["acceptance"] = {
			check: "metric",
			description: "proportion beyond SOTA",
			command: "echo METRIC proportion=0.68",
			metric: "proportion",
			direction: "at_least",
			threshold: 0.6725,
		};
		const ok = await runAcceptance(workdir, env, acceptance, () => "approve");
		expect(ok).toEqual({ passed: true, detail: "proportion=0.68" });
	});

	test("non-approved gate never executes", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-program-"));
		const { env } = await createExecutionEnv(workdir);
		const res = await runAcceptance(workdir, env, cmd("x", "true"), () => "deny");
		expect(res.passed).toBe(false);
		expect(res.detail).toContain("blocked by permission policy");
	});
});

describe("store (validated atomic persistence)", () => {
	test("save/load roundtrip; invalid program refused", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-program-"));
		const p = program([node("a"), node("b", ["a"])]);
		await saveProgram(workdir, p);
		const loaded = await loadProgram(workdir);
		expect(loaded?.nodes.map((n) => n.id)).toEqual(["a", "b"]);
		await expect(saveProgram(workdir, program([node("x", ["y"])]))).rejects.toThrow(/invalid program/);
	});

	test("loadProgramStrict: absent → undefined; corrupt/schema-invalid → throws naming the path", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-program-"));
		expect(await loadProgramStrict(workdir)).toBeUndefined();
		await Bun.write(join(workdir, "program.json"), "{ not json");
		await expect(loadProgramStrict(workdir)).rejects.toThrow(/program\.json/);
		expect(await loadProgram(workdir)).toBeUndefined(); // tolerant load keeps treating it as absent
		await Bun.write(join(workdir, "program.json"), JSON.stringify({ nope: true }));
		await expect(loadProgramStrict(workdir)).rejects.toThrow(/program\.json/);
	});
});
