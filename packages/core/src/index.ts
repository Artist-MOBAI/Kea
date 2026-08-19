import { readFileSync } from "node:fs";
export const CORE_VERSION = "0.1.0";

/** pi-stack pin, read once from packages/core/package.json (single source of truth — /version renders it). */
export const PI_STACK_VERSION: string = (() => {
	try {
		const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		return pkg.dependencies?.["@earendil-works/pi-agent-core"] ?? "unknown";
	} catch {
		return "unknown";
	}
})();

export * from "./auth-store.ts";
export * from "./budget.ts";
export * from "./compaction.ts";
export * from "./context-size.ts";
export * from "./doctor.ts";
export * from "./env.ts";
export * from "./errors.ts";
export * from "./events.ts";
export * from "./execution/index.ts";
export * from "./hooks.ts";
export * from "./injection/scheduler.ts";
export * from "./kernel.ts";
export * from "./loop/stagnation.ts";
export * from "./loop/turn-controller.ts";
export * from "./mcp.ts";
export * from "./memory.ts";
export * from "./models.ts";
export * from "./permission.ts";
export * from "./permission-rules.ts";
export * from "./plan.ts";
export * from "./provider-probe.ts";
export * from "./retry.ts";
export * from "./sensitive.ts";
export * from "./session.ts";
export * from "./session-projection.ts";
export * from "./skills.ts";
export * from "./subagent/profiles.ts";
export * from "./subagent/runner.ts";
export * from "./subagent/tools.ts";
export * from "./system-prompt.ts";
export * from "./text.ts";
export * from "./timeouts.ts";
export * from "./todo.ts";
export * from "./tools.ts";
export * from "./tools-media.ts";
export * from "./trust.ts";
export * from "./web/index.ts";
