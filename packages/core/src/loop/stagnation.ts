import { wrapSystemReminder } from "../text.ts";

export interface StagnationReason {
	kind: "repeated_call" | "failure_streak";
	toolName: string;
	count: number;
	/** level-2 reminder: the level-1 warning was ignored and the pattern continued. */
	escalated?: boolean;
}

export interface StagnationGuardOptions {
	threshold?: number;
}

/**
 * Stagnation-exempt tools: repeated same-argument calls are a normal wait pattern, not stagnation.
 * job_status is the only polling entry for background jobs (execution/tools.ts) and gets called consecutively with the same args while waiting.
 */
const EXEMPT_TOOLS: ReadonlySet<string> = new Set(["job_status"]);

export function createStagnationGuard(options: StagnationGuardOptions = {}) {
	const threshold = options.threshold ?? 3;
	// level-2 trigger: the identical pattern continuing to double the threshold means the level-1 warning was ignored
	const escalateAt = threshold * 2;
	let lastKey: string | undefined;
	let repeatCount = 0;
	let failureStreak = 0;
	let lastFailedTool = "";

	return {
		reset(): void {
			lastKey = undefined;
			repeatCount = 0;
			failureStreak = 0;
			lastFailedTool = "";
		},

		record(toolName: string, argsKey: string, isError: boolean): StagnationReason | undefined {
			// polling tools are fully exempt: not counted in repeat/failure counts, and they don't interrupt other tools' counting
			if (EXEMPT_TOOLS.has(toolName)) return undefined;
			const key = `${toolName}\u0000${argsKey}`;
			if (key === lastKey) {
				repeatCount += 1;
			} else {
				lastKey = key;
				repeatCount = 1;
			}
			if (repeatCount === threshold) {
				return { kind: "repeated_call", toolName, count: repeatCount };
			}
			if (repeatCount === escalateAt) {
				return { kind: "repeated_call", toolName, count: repeatCount, escalated: true };
			}
			if (isError) {
				failureStreak += 1;
				lastFailedTool = toolName;
				if (failureStreak === threshold) {
					return { kind: "failure_streak", toolName: lastFailedTool, count: failureStreak };
				}
				if (failureStreak === escalateAt) {
					return { kind: "failure_streak", toolName: lastFailedTool, count: failureStreak, escalated: true };
				}
			} else {
				failureStreak = 0;
			}
			return undefined;
		},
	};
}

export function stagnationMessage(reason: StagnationReason): string {
	return wrapSystemReminder(stagnationBody(reason));
}

function stagnationBody(reason: StagnationReason): string {
	if (reason.kind === "repeated_call") {
		if (reason.escalated) {
			// level 2 (structured fields + hard prohibition; every prohibition carries an alternative action)
			return [
				`[loop guard] The identical "${reason.toolName}" call is STILL repeating after a warning.`,
				`State:\n- tool: ${JSON.stringify(reason.toolName)}\n- identical_calls: ${reason.count}\n- prior_warning: ignored`,
				`You MUST NOT call "${reason.toolName}" with these arguments again. Do one of: switch tools, change the arguments, break the task into smaller steps, or report the blocker to the caller.`,
			].join("\n");
		}
		return [
			`[loop guard] You have made the identical "${reason.toolName}" call ${reason.count} times in a row with no progress.`,
			"Do NOT repeat it. Change approach: different tool, different arguments, break the task into smaller steps,",
			"or report the blocker instead of retrying.",
		].join(" ");
	}
	if (reason.escalated) {
		return [
			`[loop guard] Tool failures continue after a warning (last: "${reason.toolName}", ${reason.count} consecutive).`,
			`State:\n- last_failed_tool: ${JSON.stringify(reason.toolName)}\n- consecutive_failures: ${reason.count}\n- prior_warning: ignored`,
			`You MUST NOT retry "${reason.toolName}" the same way again. Do one of: read the error and fix its cause, try a different method, or report the blocker to the caller.`,
		].join("\n");
	}
	return [
		`[loop guard] ${reason.count} consecutive tool failures (last: "${reason.toolName}").`,
		"Stop retrying the same way. Diagnose the error, try a different method, or report the blocker.",
	].join(" ");
}
