import { describe, expect, test } from "vitest";
import {
	addNodes,
	type Program,
	type ProgramNode,
	ProgramSchema,
	pickNext,
	premiseSet,
	proveNode,
	readyNodes,
	settleComplete,
	settleRound,
} from "../src/program/index.ts";

// FLT traversal: replay the historical Fermat skeleton (Frey → Ribet → Taylor–Wiles) through the real
// API. The premise set S shrinks monotonically as implication bridges are proved; S=∅ ⟺ unconditional settle.
const cmd = (description: string, command = "true"): ProgramNode["acceptance"] => ({
	check: "command",
	description,
	command,
	expect_exit: 0,
});

const node = (id: string, kind: ProgramNode["kind"], extra: Partial<ProgramNode> = {}): ProgramNode =>
	ProgramSchema.shape.nodes.element.parse({
		id,
		kind,
		title: id,
		statement: `statement of ${id}`,
		dependsOn: [],
		acceptance: cmd(id),
		...extra,
	});

describe("FLT derivation skeleton (end-to-end traversal of the translation-skeleton engine)", () => {
	function rootProgram(): Program {
		return ProgramSchema.parse({
			objective: "prove Fermat's Last Theorem",
			criteria: [{ check: "file_exists", description: "FLT certificate", path: "flt.txt" }],
			nodes: [
				node("flt", "theorem", {
					title: "Fermat's Last Theorem",
					statement: "no positive integers a,b,c,n with n>2 satisfy a^n + b^n = c^n",
				}),
			],
			journal: [],
			instruments: [],
			barriers: [],
			status: "active",
			updatedAt: 0,
		});
	}

	test("S starts as {FLT-direct}: the root is the only open premise", () => {
		const p = rootProgram();
		expect(premiseSet(p).map((n) => n.id)).toEqual(["flt"]);
		expect(pickNext(p)).toMatchObject({ kind: "node", node: { id: "flt" } });
	});

	test("the Frey/Ribet move: a proved bridge replaces the FLT-direct premise with the modularity statement", () => {
		let p = rootProgram();
		p = addNodes(
			p,
			[
				node("ribet-bridge", "implication", {
					implies: "flt",
					domain: "modular-forms",
					bridge: true,
					statement: "every semistable elliptic curve over Q being modular ⟹ FLT",
					title: "Ribet level lowering",
				}),
				node("semistable-modularity", "theorem", {
					domain: "modular-forms",
					statement: "every semistable elliptic curve over Q is modular",
				}),
			],
			1,
		);
		// while the bridge is PENDING it covers nothing: S still names the direct statements
		const pending = premiseSet(p).map((n) => n.id);
		expect(pending).toContain("flt");
		expect(pending).toContain("semistable-modularity");

		p = proveNode(p, "ribet-bridge", 1, "Ribet 1986: the Frey curve is semistable modular only if no solution");
		const S = premiseSet(p).map((n) => n.id);
		expect(S).toHaveLength(1);
		expect(S).toEqual(["semistable-modularity"]);

		// the round settles as attributed load-bearing progress (proved THIS round, THIS node)
		const settled = settleRound({
			program: p,
			prev: { pairing: undefined, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 0 },
			phase: { kind: "attack", node: { id: "ribet-bridge" }, instrument: { id: "instr" } } as never,
			lastAssistantText: "bridge verified",
			round: 1,
		});
		expect(settled.madeProgress).toBe(true);
		expect(settled.next.roundsSinceProgress).toBe(0);
	});

	test("full traversal: bridge → lifting → decomposition → every premise discharged → settle", () => {
		let p = rootProgram();

		p = addNodes(
			p,
			[
				node("ribet-bridge", "implication", {
					implies: "flt",
					domain: "modular-forms",
					bridge: true,
					statement: "semistable modularity ⟹ FLT",
				}),
				node("semistable-modularity", "theorem", {
					domain: "modular-forms",
					statement: "all semistable curves are modular",
				}),
			],
			1,
		);
		p = proveNode(p, "ribet-bridge", 1, "level lowering");
		expect(premiseSet(p).map((n) => n.id)).toEqual(["semistable-modularity"]);

		p = addNodes(
			p,
			[
				node("modularity-lifting", "implication", {
					implies: "semistable-modularity",
					domain: "modular-forms",
					statement: "R=T for the deformation ring ⟹ semistable modularity",
				}),
				node("taylor-wiles", "theorem", {
					domain: "modular-forms",
					statement: "R=T for the semistable deformation ring",
				}),
			],
			2,
		);
		p = proveNode(p, "modularity-lifting", 2, "modularity lifting applies");
		expect(premiseSet(p).map((n) => n.id)).toEqual(["taylor-wiles"]);

		expect(readyNodes(p).map((n) => n.id)).toContain("taylor-wiles");
		p = proveNode(p, "taylor-wiles", 3, "R=T");
		expect(premiseSet(p)).toHaveLength(0);
		p = proveNode(p, "semistable-modularity", 3, "via R=T + lifting");
		expect(readyNodes(p).map((n) => n.id)).toEqual(["flt"]);

		p = proveNode(p, "flt", 4, "certificate: bridge + premise discharged");
		expect(pickNext(p).kind).toBe("empty");
		expect(premiseSet(p)).toHaveLength(0);
		p = settleComplete(p, 4, "all premises discharged; criteria machine-verified");
		expect(p.status).toBe("complete");
		expect(p.journal.at(-1)).toMatchObject({ kind: "program_completed", round: 4 });
		expect(p.nodes.map((n) => n.status)).toEqual([
			"proved", // flt
			"proved", // ribet-bridge
			"proved", // semistable-modularity
			"proved", // modularity-lifting
			"proved", // taylor-wiles
		]);
	});
});
