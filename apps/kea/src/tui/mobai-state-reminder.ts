import type { InjectionProvider } from "@kea/core";
import { untrustedObjectiveBlock } from "@kea/core";

// While a session program/mobai is live, the model must see that state on ordinary turns too, not
// only in scheduler-driven continuation prompts. The objective always goes through the
// untrusted-objective triple defense (user-typed text is data, never instructions).

export interface MobaiStateSnapshot {
	status: "active" | "paused" | "blocked" | "exhausted" | "complete" | undefined;
	kind: "program" | "mobai" | undefined;
	objective: string | undefined;
	/** Paused marker (mobaiDir/paused) — shown even when the ledger status itself stays "active". */
	paused: boolean;
}

const MOBAI_REMINDER_EVERY_TURNS = 10;

function renderReminder(snapshot: MobaiStateSnapshot): string | undefined {
	const objective = snapshot.objective?.trim() ?? "";
	const objectiveBlock = objective ? `\n${untrustedObjectiveBlock(objective)}` : "";
	const kindText = snapshot.kind === "program" ? "research program" : "objective";
	if (snapshot.paused || snapshot.status === "paused") {
		return [
			`Mobai mode is PAUSED: the session's ${kindText} below is on hold (the user paused it).`,
			"Do not work on it unless the user explicitly asks; answer the user's current request instead.",
			objectiveBlock,
		]
			.filter((line) => line !== "")
			.join("\n");
	}
	if (snapshot.status === "blocked") {
		return [
			`Mobai mode is BLOCKED: the session's ${kindText} is blocked on an external condition.`,
			"Do not resume it autonomously; the user decides when to retry or replace it.",
			objectiveBlock,
		]
			.filter((line) => line !== "")
			.join("\n");
	}
	if (snapshot.status === "active") {
		return [
			`Mobai mode is active: this session is autonomously advancing the ${kindText} below.`,
			"Unless the user's current message explicitly redirects, make concrete load-bearing progress toward it.",
			objectiveBlock,
		]
			.filter((line) => line !== "")
			.join("\n");
	}
	// complete/exhausted are transient settlement states: the lifecycle UI and queue continuation own them
	return undefined;
}

export function createMobaiStateReminderProvider(getState: () => MobaiStateSnapshot): InjectionProvider {
	let lastSignature = "";
	let turnsSinceReminder = 0;
	let reannounce = false;
	return {
		variant: "mobai_state_reminder",
		evaluate(_input): string | undefined {
			const snapshot = getState();
			const text = renderReminder(snapshot);
			if (text === undefined) {
				lastSignature = "";
				turnsSinceReminder = 0;
				return undefined;
			}
			// signature = the rendered body: any state change (status/paused/objective) re-delivers immediately
			const signature = text;
			if (reannounce || signature !== lastSignature) {
				reannounce = false;
				lastSignature = signature;
				turnsSinceReminder = 0;
				return text;
			}
			turnsSinceReminder += 1;
			if (turnsSinceReminder < MOBAI_REMINDER_EVERY_TURNS) return undefined;
			turnsSinceReminder = 0;
			return text;
		},
		onCompacted() {
			reannounce = true;
		},
	};
}
