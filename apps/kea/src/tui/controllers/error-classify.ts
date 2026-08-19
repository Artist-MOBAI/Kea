import { HookBlockedError } from "@kea/core";

export function hookBlockedReason(err: unknown): string | undefined {
	return err instanceof HookBlockedError ? err.reason : undefined;
}

// User-visible wording for a hook block — shared by the TUI status line and headless stderr.
export function hookBlockedMessage(reason: string): string {
	return `Hook blocked the prompt: ${reason}`;
}

export function classifyError(err: string): string {
	const lower = err.toLowerCase();
	if (/provider is not configured|no api key|api key not found|missing.*(api key|credential)/.test(lower)) {
		return `${err}\n    → provider credentials not configured: export the matching env var (e.g. DASHSCOPE_API_KEY), switch model with /model, or run /doctor`;
	}
	if (/(401|403|unauthorized|invalid api key|authentication|permission denied)/.test(lower)) {
		return `${err}\n    → credentials/permission issue: check the matching *_API_KEY env var, or run /doctor`;
	}
	if (/(429|rate.?limit|quota|overloaded)/.test(lower)) {
		return `${err}\n    → rate-limited/overloaded: wait a moment and retry, or switch model with /model`;
	}
	if (/(econnrefused|enotfound|econnreset|network|fetch failed|timeout|socket hang up|connection error)/.test(lower)) {
		return `${err}\n    → network/backend unreachable: retry, or run /doctor to check the execution backend`;
	}
	return err;
}
