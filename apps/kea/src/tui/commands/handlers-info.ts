import { type Kernel, runDoctor } from "@kea/core";
import { FAILURE_MARK, SUCCESS_MARK } from "../constants/symbols.ts";
import { createTheme } from "../theme.ts";
import type { SlashCommandHost } from "./types.ts";

export function showPanel(host: SlashCommandHost, title: string, lines: string[]): void {
	host.openInfoPanel(title, lines);
}

export async function handleMcp(host: SlashCommandHost, kernel: Kernel): Promise<void> {
	const statuses = kernel.mcpStatuses();
	if (statuses.length === 0) {
		host.showStatus("No MCP servers configured (.kea/mcp.json)");
		return;
	}
	const { dim } = createTheme();
	showPanel(
		host,
		"MCP Servers",
		statuses.flatMap((s) => {
			const main = s.connected
				? `${SUCCESS_MARK} ${s.server}: ${s.tools} tools`
				: `${FAILURE_MARK} ${s.server}: ${s.error ?? "connection failed"}`;
			return [main, ...(s.notes ?? []).map((n) => dim(`  · ${n}`))];
		}),
	);
}

export function handleContext(host: SlashCommandHost, kernel: Kernel): void {
	const estimate = kernel.contextTokens();
	const window = kernel.contextWindow;
	const usage = kernel.usage();
	showPanel(host, "Context", [
		`Messages: ${kernel.agent.state.messages.length}`,
		`Context tokens: ${estimate} / ${window} (${window > 0 ? Math.round((estimate / window) * 100) : "?"}%)`,
		`Total input/output: ${usage.tokens} tokens · $${usage.usd.toFixed(4)}`,
		"Compaction policy: threshold-triggered + research-summary instructions (negative results are always kept)",
	]);
}

export async function handleDoctor(host: SlashCommandHost): Promise<void> {
	const checks = await runDoctor(host.cwd);
	showPanel(
		host,
		"Environment doctor",
		checks.map((c) => `${c.ok ? SUCCESS_MARK : FAILURE_MARK} ${c.name}: ${c.detail}${c.hint ? ` — ${c.hint}` : ""}`),
	);
}
