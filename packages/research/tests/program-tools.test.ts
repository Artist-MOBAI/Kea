import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionEnv } from "@kea/core";
import { afterAll, describe, expect, test } from "vitest";
import { loadProgram, packById, saveProgram } from "../src/program/index.ts";
import { createProgramTools } from "../src/program-tools.ts";

let workdir: string;
afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

interface Tool {
	name: string;
	description: string;
	execute: (id: string, params: unknown) => Promise<unknown>;
}

async function makeTools(approve = true) {
	workdir = await mkdtemp(join(tmpdir(), "kea2-progtools-"));
	const { env } = await createExecutionEnv(workdir);
	const tools = createProgramTools({
		cwd: workdir,
		env,
		mobaiDir: () => join(workdir, ".kea"),
		reviewCommand: () => (approve ? "approve" : "deny"),
		currentRound: () => 7,
	});
	const byName = (name: string): Tool => {
		const tool = tools.find((t) => t.name === name);
		if (!tool) throw new Error(`tool not found: ${name}`);
		return tool as unknown as Tool;
	};
	return { byName, workdir };
}

const programArgs = {
	objective: "prove the tiny theorem",
	criteria: [{ check: "file_exists" as const, description: "marker exists", path: "marker.txt" }],
	nodes: [
		{
			id: "n1",
			kind: "lemma" as const,
			title: "write the marker",
			statement: "the file marker.txt exists in the workspace",
			dependsOn: [],
			acceptance: {
				check: "command" as const,
				description: "marker exists",
				command: "test -f marker.txt",
				expect_exit: 0,
			},
		},
		{
			id: "n2",
			kind: "theorem" as const,
			title: "metric node",
			statement: "the computed value is at least 2",
			dependsOn: ["n1"],
			acceptance: {
				check: "metric" as const,
				description: "value from stdout",
				command: "echo METRIC value=2",
				metric: "value",
				direction: "at_least" as const,
				threshold: 2,
			},
		},
	],
};

describe("start_program", () => {
	test("formalizes a validated DAG and refuses re-formalization while unfinished", async () => {
		const { byName } = await makeTools();
		const res = (await byName("start_program").execute("t1", programArgs)) as { content: Array<{ text: string }> };
		expect(res.content[0]?.text).toContain("2 nodes");
		await expect(byName("start_program").execute("t2", programArgs)).rejects.toThrow(/unfinished program/);
	});

	test("invalid graph (cycle) refused at formalization", async () => {
		const { byName } = await makeTools();
		const cyclic = {
			...programArgs,
			nodes: [
				{ ...programArgs.nodes[0], id: "a", dependsOn: ["b"] },
				{ ...programArgs.nodes[1], id: "b", dependsOn: ["a"] },
			],
		};
		await expect(byName("start_program").execute("t1", cyclic)).rejects.toThrow(/invalid program graph/);
	});
});

describe("update_node proved = machine acceptance gate", () => {
	test("refused while acceptance fails; passes once the workspace satisfies it", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t1", programArgs);
		await expect(
			byName("update_node").execute("t2", { action: "proved", nodeId: "n1", evidence: "claim" }),
		).rejects.toThrow(/machine acceptance.*FAILED/);
		const program = await loadProgram(join(workdir, ".kea"));
		expect(program?.nodes[0]?.status).toBe("pending"); // unchanged

		const { env } = await createExecutionEnv(workdir);
		await env.exec("touch marker.txt", { cwd: workdir, timeout: 10 });
		await expect(
			byName("update_node").execute("t3", { action: "proved", nodeId: "n1", evidence: "wrote it" }),
		).resolves.toBeTruthy();
		const after = await loadProgram(join(workdir, ".kea"));
		expect(after?.nodes[0]?.status).toBe("proved");
		expect(after?.nodes[0]?.evidence).toContain("exit=0");
		expect(after?.journal.at(-1)).toMatchObject({ kind: "node_proved", nodeId: "n1", round: 7 });
	});

	test("metric acceptance: threshold pass/fail decides the transition", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t1", programArgs);
		const { env } = await createExecutionEnv(workdir);
		await env.exec("touch marker.txt", { cwd: workdir, timeout: 10 });
		await byName("update_node").execute("t2", { action: "proved", nodeId: "n1", evidence: "marker" });
		await expect(
			byName("update_node").execute("t3", { action: "proved", nodeId: "n2", evidence: "x" }),
		).resolves.toBeTruthy();
	});

	test("non-approved permission gate blocks execution and the transition", async () => {
		const { byName } = await makeTools(false);
		await byName("start_program").execute("t1", programArgs);
		await expect(
			byName("update_node").execute("t2", { action: "proved", nodeId: "n1", evidence: "x" }),
		).rejects.toThrow(/machine acceptance.*FAILED.*blocked by permission policy/);
	});

	test("already-proved / dependency-missing: throws BEFORE any acceptance subprocess runs", async () => {
		const { byName, workdir: dir } = await makeTools();
		await byName("start_program").execute("t1", programArgs);
		const { env: rawEnv } = await createExecutionEnv(dir);
		await rawEnv.exec("touch marker.txt", { cwd: dir, timeout: 10 }); // acceptance WOULD pass — only the precondition can throw
		let execCalls = 0;
		const countingEnv = new Proxy(rawEnv, {
			get(target, prop) {
				if (prop === "exec") {
					return (command: string, options?: Parameters<typeof rawEnv.exec>[1]) => {
						execCalls++;
						return target.exec(command, options);
					};
				}
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const tools = createProgramTools({
			cwd: dir,
			env: countingEnv,
			mobaiDir: () => join(dir, ".kea"),
			reviewCommand: () => "approve",
			currentRound: () => 7,
		});
		const updateNode = tools.find((t) => t.name === "update_node") as unknown as Tool;

		// dependency-missing first: n2 depends on n1 — no acceptance may run
		await expect(updateNode.execute("p1", { action: "proved", nodeId: "n2", evidence: "x" })).rejects.toThrow(
			/unproved dependencies/,
		);
		expect(execCalls).toBe(0);

		await updateNode.execute("p2", { action: "proved", nodeId: "n1", evidence: "x" });
		expect(execCalls).toBe(1); // exactly one acceptance subprocess for the real prove

		await expect(updateNode.execute("p3", { action: "proved", nodeId: "n1", evidence: "x" })).rejects.toThrow(
			/already proved/,
		);
		expect(execCalls).toBe(1); // repeat-prove burns zero acceptance runs
	});
});

describe("add_nodes + program_note", () => {
	test("re-planning extends the DAG; notes with nodeId are attached but never load-bearing", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t1", programArgs);
		await byName("add_nodes").execute("t2", {
			nodes: [
				{
					id: "n3",
					kind: "computation",
					title: "check higher height",
					statement: "certify zeros to 10^4",
					dependsOn: ["n2"],
					acceptance: { check: "command", description: "certify", command: "true", expect_exit: 0 },
				},
			],
		});
		const program = await loadProgram(join(workdir, ".kea"));
		expect(program?.nodes.map((n) => n.id)).toContain("n3");

		await byName("program_note").execute("t3", {
			kind: "note",
			description: "halfway on n1",
			evidence: "draft in notes.md",
			nodeId: "n1",
		});
		const noted = await loadProgram(join(workdir, ".kea"));
		expect(noted?.journal.at(-1)?.nodeId).toBe("n1");
		expect(noted?.journal.at(-1)?.kind).toBe("note");
	});

	test("implication nodes round-trip implies/domain/bridge/imported", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t1", programArgs);
		await byName("add_nodes").execute("t2", {
			nodes: [
				{
					id: "sm-impl",
					kind: "implication",
					title: "semistable modularity ⟹ flt",
					statement: "bridge statement",
					dependsOn: [],
					implies: "n1",
					domain: "modular-forms",
					bridge: true,
					imported: { source: "Ribet 1990", reference: "Theorem B" },
					acceptance: { check: "command", description: "bridge check", command: "true", expect_exit: 0 },
				},
			],
		});
		const program = await loadProgram(join(workdir, ".kea"));
		const added = program?.nodes.find((n) => n.id === "sm-impl");
		expect(added).toMatchObject({
			kind: "implication",
			implies: "n1",
			domain: "modular-forms",
			bridge: true,
			imported: { source: "Ribet 1990", reference: "Theorem B" },
		});
	});

	test("implication pointing at an unknown node is refused (graph validation)", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t1", programArgs);
		await expect(
			byName("add_nodes").execute("t2", {
				nodes: [
					{
						id: "bad-impl",
						kind: "implication",
						title: "bad bridge",
						statement: "s",
						dependsOn: [],
						implies: "ghost-node",
						acceptance: { check: "command", description: "d", command: "true", expect_exit: 0 },
					},
				],
			}),
		).rejects.toThrow(/implies unknown node/);
	});
});

describe("update_node park / unparked / restate", () => {
	test("park requires a reason; parked nodes are shelved with a load-bearing entry", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t1", programArgs);
		await expect(byName("update_node").execute("t2", { action: "parked", nodeId: "n1" })).rejects.toThrow(
			/parking requires a reason/,
		);
		await expect(byName("update_node").execute("t3", { action: "parked", nodeId: "ghost" })).rejects.toThrow(
			/unknown node/,
		);
		const res = (await byName("update_node").execute("t4", {
			action: "parked",
			nodeId: "n1",
			reason: "finite search for a nonexistent counterexample",
		})) as { content: Array<{ text: string }> };
		expect(res.content[0]?.text).toContain("parked");
		const program = await loadProgram(join(workdir, ".kea"));
		expect(program?.nodes[0]?.status).toBe("parked");
		expect(program?.nodes[0]?.parkedReason).toBe("finite search for a nonexistent counterexample");
		expect(program?.journal.at(-1)).toMatchObject({ kind: "node_parked", nodeId: "n1", round: 7 });

		// unpark re-opens it (round stamp preserved)
		await byName("update_node").execute("t5", { action: "unparked", nodeId: "n1" });
		const reopened = await loadProgram(join(workdir, ".kea"));
		expect(reopened?.nodes[0]?.status).toBe("pending");
		expect(reopened?.nodes[0]?.parkedReason).toBeUndefined();
		await expect(byName("update_node").execute("t6", { action: "unparked", nodeId: "n1" })).rejects.toThrow(
			/not parked/,
		);
	});

	test("restate with nothing to change is refused; a bounded restate is load-bearing", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t1", programArgs);
		await expect(byName("update_node").execute("t2", { action: "restate", nodeId: "n1" })).rejects.toThrow(
			/at least one of/,
		);
		await expect(
			byName("update_node").execute("t3", { action: "restate", nodeId: "ghost", statement: "x" }),
		).rejects.toThrow(/unknown node/);
		await byName("update_node").execute("t4", {
			action: "restate",
			nodeId: "n1",
			title: "marker (bounded)",
			statement: "the file marker.txt exists OR the workspace is empty",
			acceptance: { check: "command", description: "bounded acceptance", command: "true", expect_exit: 0 },
		});
		const program = await loadProgram(join(workdir, ".kea"));
		expect(program?.nodes[0]?.title).toBe("marker (bounded)");
		expect(program?.nodes[0]?.acceptance.description).toBe("bounded acceptance");
		expect(program?.journal.at(-1)).toMatchObject({ kind: "node_restated", nodeId: "n1", round: 7 });
		const { env } = await createExecutionEnv(workdir);
		await env.exec("touch marker.txt", { cwd: workdir, timeout: 10 });
		await byName("update_node").execute("t5", { action: "proved", nodeId: "n1", evidence: "marker" });
		await expect(
			byName("update_node").execute("t6", { action: "restate", nodeId: "n1", statement: "x" }),
		).rejects.toThrow(/proved/);
	});
});

describe("start_program: exhausted programs may be re-formalized (audit #9)", () => {
	test("active program blocks re-formalization; exhausted does not", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t1", programArgs);
		await expect(byName("start_program").execute("t2", programArgs)).rejects.toThrow(/unfinished program/);

		const program = await loadProgram(join(workdir, ".kea"));
		if (!program) throw new Error("program missing after start_program");
		await saveProgram(join(workdir, ".kea"), { ...program, status: "exhausted" });
		await expect(byName("start_program").execute("t3", programArgs)).resolves.toBeTruthy();
		const fresh = await loadProgram(join(workdir, ".kea"));
		expect(fresh?.status).toBe("active"); // the new program replaces the drained skeleton
		expect(fresh?.journal).toHaveLength(0);
	});
});

describe("settled-program guard: mutations against a terminal ledger are refused", () => {
	test("update_node / add_nodes / program_note refuse on a COMPLETE program", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t1", programArgs);
		const program = await loadProgram(join(workdir, ".kea"));
		if (!program) throw new Error("program missing after start_program");
		await saveProgram(join(workdir, ".kea"), { ...program, status: "complete" });

		await expect(byName("update_node").execute("t2", { action: "started", nodeId: "n1" })).rejects.toThrow(
			/program is settled \(complete\)/,
		);
		await expect(
			byName("add_nodes").execute("t3", {
				nodes: [
					{
						id: "late",
						kind: "computation",
						title: "late addition",
						statement: "s",
						dependsOn: [],
						acceptance: { check: "command", description: "d", command: "true", expect_exit: 0 },
					},
				],
			}),
		).rejects.toThrow(/program is settled \(complete\)/);
		await expect(
			byName("program_note").execute("t4", { kind: "note", description: "d", evidence: "e" }),
		).rejects.toThrow(/program is settled \(complete\)/);
		// the ledger itself is untouched (the terminal stays a fact, not a suggestion)
		const unchanged = await loadProgram(join(workdir, ".kea"));
		expect(unchanged?.journal).toHaveLength(program.journal.length);
	});

	test("same refusal on an EXHAUSTED program (re-formalization via start_program is the only path)", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t1", programArgs);
		const program = await loadProgram(join(workdir, ".kea"));
		if (!program) throw new Error("program missing after start_program");
		await saveProgram(join(workdir, ".kea"), { ...program, status: "exhausted" });
		await expect(
			byName("program_note").execute("t2", { kind: "note", description: "d", evidence: "e" }),
		).rejects.toThrow(/program is settled \(exhausted\)/);
	});

	test("register_instrument / calibrate_instrument / record_barrier refuse on a COMPLETE program", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t1", programArgs);
		const program = await loadProgram(join(workdir, ".kea"));
		if (!program) throw new Error("program missing after start_program");
		await saveProgram(join(workdir, ".kea"), { ...program, status: "complete" });

		const draft = {
			id: "late-tool",
			version: 1,
			artifacts: [],
			recovers: [
				{ theorem: "T", check: { check: "command" as const, description: "d", command: "true", expect_exit: 0 } },
			],
			novelty: {
				statement: "n",
				check: { check: "command" as const, description: "d", command: "true", expect_exit: 0 },
			},
		};
		// the settled guard fires BEFORE any instrument lookup/validation — terminal state is a ledger fact
		await expect(byName("register_instrument").execute("t2", draft)).rejects.toThrow(/program is settled \(complete\)/);
		await expect(byName("calibrate_instrument").execute("t3", { instrumentId: "late-tool" })).rejects.toThrow(
			/program is settled \(complete\)/,
		);
		await expect(byName("record_barrier").execute("t4", { instrumentId: "late-tool", statement: "s" })).rejects.toThrow(
			/program is settled \(complete\)/,
		);
		const unchanged = await loadProgram(join(workdir, ".kea"));
		expect(unchanged?.instruments).toHaveLength(0); // the draft never landed
		expect(unchanged?.barriers).toHaveLength(0);
		expect(unchanged?.journal).toHaveLength(program.journal.length);
	});
});

describe("discipline persistence (P1: metric programs must not degrade to math vocabulary)", () => {
	test("start_program persists the discipline pack id and it round-trips through program.json", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t1", { ...programArgs, discipline: "metric" });
		const program = await loadProgram(join(workdir, ".kea"));
		expect(program?.discipline).toBe("metric");
		// persisted pack is what round prompts re-read (packById) on continue
		expect(packById(program?.discipline).id).toBe("metric");
	});

	test("absent discipline parses as undefined (pre-field ledgers keep math behavior)", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t1", programArgs);
		const program = await loadProgram(join(workdir, ".kea"));
		expect(program?.discipline).toBeUndefined();
	});
});

describe("implication skeleton edges (graph validation)", () => {
	test("an implication node implying ITSELF is refused (self-dependency)", async () => {
		const { byName } = await makeTools();
		await byName("start_program").execute("t1", programArgs);
		await expect(
			byName("add_nodes").execute("t2", {
				nodes: [
					{
						id: "self-loop",
						kind: "implication",
						title: "circular bridge",
						statement: "s",
						dependsOn: [],
						implies: "self-loop",
						acceptance: { check: "command", description: "d", command: "true", expect_exit: 0 },
					},
				],
			}),
		).rejects.toThrow(/implies itself/);
	});
});

describe("tool description contract line pins (stable model-visible text, DSH discipline)", () => {
	test("each of the seven tools pins one machine contract line", async () => {
		const { byName } = await makeTools();
		expect(byName("start_program").description).toContain(
			"REFUSED while an unfinished program exists — continue it with update_node / add_nodes / program_note instead",
		);
		expect(byName("update_node").description).toContain(
			'"proved" runs the node\'s machine acceptance FIRST — the transition is REFUSED unless it passes',
		);
		expect(byName("add_nodes").description).toContain(
			"The whole graph is re-validated (no cycles, no unknown dependencies) before persisting",
		);
		expect(byName("program_note").description).toContain("A note NEVER counts as progress");
		expect(byName("register_instrument").description).toContain(
			"machine-verifies EVERY recovery contract and the novelty witness — narration does not count",
		);
		expect(byName("calibrate_instrument").description).toContain("Any failure REFUSES the calibration");
		expect(byName("record_barrier").description).toContain("stored as a note that does NOT count as progress");
	});
});

describe("corrupt program.json: guards fail loud, never fall through to overwrite (G6)", () => {
	test("start_program on an unparseable ledger: names the file, disk stays byte-identical", async () => {
		const { byName, workdir: dir } = await makeTools();
		const corruptPath = join(dir, ".kea", "program.json");
		const corrupt = "{ broken ledger";
		await Bun.write(corruptPath, corrupt);
		await expect(byName("start_program").execute("t1", programArgs)).rejects.toThrow(
			/program ledger is corrupted.*program\.json/,
		);
		await expect(byName("start_program").execute("t2", programArgs)).rejects.toThrow(/\/mobai clear/);
		expect(await Bun.file(corruptPath).text()).toBe(corrupt); // never overwritten
	});

	test("schema-invalid ledger (valid JSON, wrong shape) is refused the same way", async () => {
		const { byName, workdir: dir } = await makeTools();
		const path = join(dir, ".kea", "program.json");
		await Bun.write(path, JSON.stringify({ objective: "x" }));
		await expect(byName("start_program").execute("t1", programArgs)).rejects.toThrow(
			/schema validation.*program\.json/,
		);
		expect(JSON.parse(await Bun.file(path).text())).toEqual({ objective: "x" });
	});

	test("absent program.json keeps the create path", async () => {
		const { byName } = await makeTools();
		await expect(byName("start_program").execute("t1", programArgs)).resolves.toBeTruthy();
	});
});
