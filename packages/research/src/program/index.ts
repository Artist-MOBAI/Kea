// Research-program core: a machine-checked dependency DAG of work units plus an append-only
// load-bearing journal, driven by a pure scheduler. schema / graph / transitions / ledger /
// scheduler / prompt are pure (unit-tested without IO); verify (execution) and store (persistence)
// are the only effectful edges.

export * from "./discipline.ts";
export * from "./graph.ts";
export * from "./judge.ts";
export * from "./ledger.ts";
export * from "./prompt.ts";
export * from "./scheduler.ts";
export * from "./schema.ts";
export * from "./settle.ts";
export * from "./store.ts";
export * from "./transitions.ts";
export * from "./verify.ts";
