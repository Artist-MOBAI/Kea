import type { Program, ProgramNode } from "./schema.ts";

// Pure DAG operations: no IO, no mutation. Structural validation is separate from scheduling so a
// malformed program fails loudly at write time, never silently inside the loop.

export interface GraphIssue {
	kind: "duplicate-id" | "unknown-dependency" | "cycle" | "self-dependency";
	detail: string;
}

export function validateProgram(program: Program): GraphIssue[] {
	const issues: GraphIssue[] = [];
	const byId = new Map<string, ProgramNode>();
	for (const node of program.nodes) {
		if (byId.has(node.id)) issues.push({ kind: "duplicate-id", detail: `duplicate node id "${node.id}"` });
		else byId.set(node.id, node);
	}
	const instrumentIds = new Set(program.instruments.map((i) => i.id));
	for (const node of program.nodes) {
		for (const dep of node.dependsOn) {
			if (dep === node.id) issues.push({ kind: "self-dependency", detail: `node "${node.id}" depends on itself` });
			else if (!byId.has(dep))
				issues.push({ kind: "unknown-dependency", detail: `node "${node.id}" depends on unknown "${dep}"` });
		}
		// an unresolvable instrumentId must fail loudly at write time — no silent declared-or-latest fallback
		if (node.instrumentId !== undefined && !instrumentIds.has(node.instrumentId)) {
			issues.push({
				kind: "unknown-dependency",
				detail: `node "${node.id}" declares unknown instrument "${node.instrumentId}"`,
			});
		}
		if (node.kind === "implication" && node.implies === node.id) {
			issues.push({ kind: "self-dependency", detail: `implication node "${node.id}" implies itself` });
		} else if (node.kind === "implication" && node.implies !== undefined && !byId.has(node.implies)) {
			issues.push({
				kind: "unknown-dependency",
				detail: `implication node "${node.id}" implies unknown node "${node.implies}"`,
			});
		}
	}

	// three-color DFS: WHITE=unvisited, GRAY=on stack, BLACK=done
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map<string, number>();
	for (const node of program.nodes) color.set(node.id, WHITE);
	const stack: Array<{ id: string; iter: number }> = [];

	for (const start of program.nodes) {
		if (color.get(start.id) !== WHITE) continue;
		color.set(start.id, GRAY);
		stack.push({ id: start.id, iter: 0 });
		while (stack.length > 0) {
			const top = stack[stack.length - 1];
			if (top === undefined) break;
			const node = byId.get(top.id);
			const deps = node?.dependsOn ?? [];
			if (top.iter < deps.length) {
				const dep = deps[top.iter];
				top.iter += 1;
				if (dep === undefined || !byId.has(dep)) continue; // unknown deps already reported
				const c = color.get(dep) ?? WHITE;
				if (c === GRAY) {
					issues.push({ kind: "cycle", detail: `dependency cycle through "${dep}"` });
				} else if (c === WHITE) {
					color.set(dep, GRAY);
					stack.push({ id: dep, iter: 0 });
				}
			} else {
				color.set(top.id, BLACK);
				stack.pop();
			}
		}
	}
	return issues;
}

export function nodeById(program: Program, id: string): ProgramNode | undefined {
	return program.nodes.find((n) => n.id === id);
}

export function dependenciesSatisfied(program: Program, node: ProgramNode): boolean {
	return node.dependsOn.every((dep) => nodeById(program, dep)?.status === "proved");
}

/** pending/active with all deps proved; parked excluded (not attackable by the current generation). */
export function readyNodes(program: Program): ProgramNode[] {
	return program.nodes.filter(
		(n) => (n.status === "pending" || n.status === "active") && dependenciesSatisfied(program, n),
	);
}

export function parkedNodes(program: Program): ProgramNode[] {
	return program.nodes.filter((n) => n.status === "parked");
}

// The premise set S of the conditional skeleton: open leaves the objective transitively depends on.
// S = ∅ with all implication edges proved ⟺ unconditional settlement; shrinking S is the engine's
// progress metric — a mathematical quantity, not a narrative one.
export function premiseSet(program: Program): ProgramNode[] {
	// open work consumes its dependencies; a PROVED implication discharges its premise ("H′ ⟹ H" proved
	// replaces H with H′'s decomposition). A pending bridge covers nothing — until its acceptance
	// passes, the direct statement stays the working premise.
	const dependedOn = new Set<string>();
	for (const node of program.nodes) {
		if (node.status === "refuted") continue;
		if (node.status === "proved") {
			if (node.kind === "implication" && node.implies !== undefined) dependedOn.add(node.implies);
			continue;
		}
		for (const dep of node.dependsOn) dependedOn.add(dep);
	}
	return program.nodes.filter(
		(n) => (n.status === "pending" || n.status === "active" || n.status === "parked") && !dependedOn.has(n.id),
	);
}

export function dependentsOf(program: Program, id: string): ProgramNode[] {
	return program.nodes.filter((n) => n.dependsOn.includes(id));
}

// Critical-path depth: longest chain of unproved dependents below a node. Memoized per call (a shared
// visited set would undercount diamond graphs); the path-local set only guards re-entry on corrupt data.
export function downstreamDepth(program: Program, id: string): number {
	const memo = new Map<string, number>();
	const visit = (nid: string, path: Set<string>): number => {
		const cached = memo.get(nid);
		if (cached !== undefined) return cached;
		if (path.has(nid)) return 0;
		path.add(nid);
		let best = 0;
		for (const child of dependentsOf(program, nid)) {
			if (child.status === "proved" || child.status === "refuted") continue;
			best = Math.max(best, 1 + visit(child.id, path));
		}
		path.delete(nid);
		memo.set(nid, best);
		return best;
	};
	return visit(id, new Set());
}

// Nodes that can never become ready: some transitive dependency is `refuted` — the subtree needs
// re-planning, not waiting.
export function unreachableNodes(program: Program): ProgramNode[] {
	const dead = new Set<string>();
	const isDead = (id: string, guard: Set<string>): boolean => {
		if (dead.has(id)) return true;
		if (guard.has(id)) return false; // cycle guard; validation prevents this in practice
		const node = nodeById(program, id);
		if (node === undefined) return true;
		if (node.status === "refuted") return true;
		if (node.status === "proved" || node.status === "pending" || node.status === "active") {
			if (node.status === "pending" || node.status === "active") {
				guard.add(id);
				const blocked = node.dependsOn.some((dep) => isDead(dep, guard));
				guard.delete(id);
				if (blocked) {
					dead.add(id);
					return true;
				}
			}
		}
		return false;
	};
	return program.nodes.filter(
		(n) => n.status !== "proved" && n.status !== "refuted" && n.status !== "parked" && isDead(n.id, new Set()),
	);
}
