import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { InjectionInput, InjectionProvider } from "./injection/scheduler.ts";
import { keaHome } from "./trust.ts";

// Plan mode (tool-ized): the agent enters/exits the planning flow via enter_plan_mode/exit_plan_mode. The plan
// file is the only writable target, exit reads the file rather than taking plan text, and the review gate
// precedes yolo in the policy chain (review is mandatory in non-auto modes).

export interface PlanState {
	active: boolean;
	id?: string;
	path?: string;
}

export function planSlug(id: string): string {
	const base = id
		.replace(/[^a-z0-9]/gi, "")
		.toLowerCase()
		.slice(0, 8);
	return base === "" ? "plan" : `plan-${base}`;
}

/** Home-level plan store: `~/.kea/plans/` (KEA_HOME respected) — outside the workspace ledger tree;
 *  `plans` is the only model-writable `.kea` namespace by ledger-guard contract. */
export function plansDir(): string {
	return join(keaHome(), ".kea", "plans");
}

export class PlanService {
	private state: PlanState = { active: false };

	get current(): PlanState {
		return this.state;
	}

	enter(sessionId: string): PlanState {
		const dir = join(plansDir(), sessionId);
		const path = join(dir, "plan.md");
		try {
			mkdirSync(dir, { recursive: true });
			// Create the (empty) plan file up front: it is immediately visible/editable outside the
			// TUI, and the exit-time non-empty check has a stable anchor. wx: EEXIST = already created.
			writeFileSync(path, "", { flag: "wx" });
		} catch {
			// directory creation failure does not block entering plan mode (the real failure happens when writing the plan file)
		}
		this.state = { active: true, id: sessionId, path };
		return this.state;
	}

	exit(): void {
		this.state = { active: false };
	}
}

export const ENTER_PLAN_MODE_TOOL = "enter_plan_mode";
export const EXIT_PLAN_MODE_TOOL = "exit_plan_mode";

/** Reserved ExitPlanMode option labels (approval-UI reserved actions; must not be taken by model options). */
const RESERVED_OPTION_LABELS = ["approve", "reject", "reject and exit", "revise"];

export interface PlanToolCallbacks {
	plan: PlanService;
	isActive(): boolean;
	enterPlan(): void;
	exitPlan(): void;
	readPlanFile(): Promise<string>;
	/** Optional transcript annotation for HOW the exit was approved (e.g. auto-mode "Auto-approved"). */
	approvalNote?(): string;
}

export function createEnterPlanModeTool(cb: PlanToolCallbacks) {
	const parameters = z.strictObject({});
	return {
		name: ENTER_PLAN_MODE_TOOL,
		label: "Enter plan mode",
		description: [
			"Enter plan mode: read-only exploration plus writing ONE plan file.",
			"While active, every write except the plan file is BLOCKED and command execution is DENIED.",
			"Enter for non-trivial multi-step work; for trivial work use the normal tools directly.",
			"When the plan is ready, call exit_plan_mode — the plan is read from the plan file, NEVER passed as a parameter.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, _params: z.input<typeof parameters>) {
			if (cb.isActive()) {
				return {
					content: [{ type: "text", text: "Plan mode is already active. Use exit_plan_mode when the plan is ready." }],
					details: {},
					isError: true,
				};
			}
			cb.enterPlan();
			const path = cb.plan.current.path ?? "";
			const text = [
				"Plan mode: ON.",
				`Write your plan to: ${path}`,
				"Explore read-only, design the approach, then write the complete plan to that file.",
				"When ready, call exit_plan_mode to submit it for review.",
			].join("\n");
			return { content: [{ type: "text", text }], details: { planPath: path } };
		},
	};
}

export interface ExitPlanModeParams {
	options?: Array<{ label: string; description?: string }>;
}

export function createExitPlanModeTool(cb: PlanToolCallbacks) {
	const parameters = z.strictObject({
		options: z
			.array(
				z.strictObject({
					label: z.string().meta({ description: "Short name (1-8 words) for this approach." }),
					description: z.string().optional().meta({ description: "Brief summary of the approach and trade-offs." }),
				}),
			)
			.min(1)
			.max(3)
			.optional()
			.meta({ description: "Alternative approaches for the user to choose from." }),
	});
	return {
		name: EXIT_PLAN_MODE_TOOL,
		label: "Exit plan mode",
		description: [
			"Submit the plan for review and leave plan mode on approval.",
			"The plan content is read from the plan file; this tool takes NO plan text, and an empty plan file is REFUSED.",
			"On rejection plan mode stays active: revise the plan file and submit again.",
		].join("\n"),
		parameters: z.toJSONSchema(parameters),
		executionMode: "sequential",
		async execute(_id: string, params: z.input<typeof parameters>) {
			if (!cb.isActive()) {
				return {
					content: [{ type: "text", text: "Plan mode is not active." }],
					details: {},
					isError: true,
				};
			}
			if (params.options) {
				const seen = new Set<string>();
				for (const opt of params.options) {
					const label = opt.label.trim().toLowerCase();
					if (RESERVED_OPTION_LABELS.includes(label)) {
						return {
							content: [{ type: "text", text: `Option label "${opt.label}" is reserved. Rephrase and call again.` }],
							details: {},
							isError: true,
						};
					}
					if (seen.has(label)) {
						return {
							content: [{ type: "text", text: `Duplicate option label "${opt.label}". Rephrase and call again.` }],
							details: {},
							isError: true,
						};
					}
					seen.add(label);
				}
			}
			const planText = (await cb.readPlanFile()).trim();
			if (planText === "") {
				// pi upstream discipline: Kea's own tools throw directly on error (pi records isError); afterToolCall only needs to cover MCP passthrough
				throw new Error("The plan file is empty. Write the plan to the plan file first, then submit.");
			}
			// exitPlan() clears path: capture before exiting
			const path = cb.plan.current.path ?? "";
			cb.exitPlan();
			const optionsText = params.options ? `\nOptions offered: ${params.options.map((o) => o.label).join(" / ")}` : "";
			const approvalNote = cb.approvalNote?.() ?? "";
			const text = `Exited plan mode.${optionsText}${approvalNote}\nPlan saved to: ${path}\n\n## Approved Plan:\n${planText}`;
			return { content: [{ type: "text", text }], details: { planPath: path } };
		},
	};
}

// plan reminder throttle cadence: remind every 10 assistant turns, avoiding an extra LLM iteration every turn.
export const PLAN_REMINDER_EVERY_TURNS = 10;

// Plan-mode reminder, two levels: level 1 — a gentle reminder on entering plan mode and every
// PLAN_REMINDER_EVERY_TURNS collections; level 2 — structured fields + hard prohibition once plan mode is STILL
// active at the next cadence tick after a level-1 reminder was ignored. Throttle resets on leaving plan mode;
// replay once after compaction (the reminder may have been summarized out of context).
export function createPlanReminderProvider(
	isActive: () => boolean,
	planPath: () => string | undefined,
): InjectionProvider {
	let active = false;
	let turnsSinceReminder = 0;
	let reannounce = false;
	let remindersSent = 0;

	// reentry = the current plan file already holds content (a real prior plan to build on). An in-memory
	// "has entered" flag survives exit/re-enter cycles and would claim a prior plan exists at the freshly
	// created (empty) path — a contradiction the model cannot resolve.
	const planHasContent = (): boolean => {
		const path = planPath();
		if (!path) return false;
		try {
			return readFileSync(path, "utf8").trim().length > 0;
		} catch {
			return false;
		}
	};

	const reminderText = (reentry = false): string => {
		const path = planPath();
		if (remindersSent <= 1) {
			const lines = [
				"Plan mode is active. You MUST NOT make any edits (with the exception of the current plan file) or otherwise make changes to the system unless a tool request is explicitly approved. Prefer read-only tools. This supersedes any other instructions you have received.",
				"Workflow:",
				"1. Understand — explore the codebase with glob, grep, read.",
				"2. Design — converge on the best approach; aim for a single recommendation.",
				"3. Review — re-read key files to verify understanding.",
				"4. Write Plan — write the complete plan to the plan file.",
				"5. Exit — call exit_plan_mode for user approval.",
				`Plan file: ${path}.`,
			];
			if (reentry) {
				lines.push(
					"A prior plan already exists at this path — read it first, then revise it rather than starting over.",
				);
			}
			lines.push(
				"Your turn must end with exit_plan_mode once the plan is written. Do NOT end your turn any other way.",
			);
			return lines.join("\n");
		}
		// level 2: the gentle reminder was ignored — structured state + hard prohibition
		return [
			"[plan mode] Plan mode is still active after a reminder.",
			`State:\n- plan_file: ${path ?? "(unset)"}\n- reminders_sent: ${remindersSent}`,
			"You MUST NOT edit any file except the plan file, and you MUST NOT run state-changing commands. Read-only tools ONLY.",
			"End your turn with exit_plan_mode once the plan file holds the complete plan.",
		].join("\n");
	};

	return {
		variant: "plan_mode",
		evaluate(_input: InjectionInput): string | undefined {
			if (!isActive()) {
				active = false;
				turnsSinceReminder = 0;
				reannounce = false;
				remindersSent = 0;
				return undefined;
			}
			// just entered plan mode (or needs replay after compaction): remind immediately and restart counting
			if (!active || reannounce) {
				const reentry = planHasContent();
				active = true;
				reannounce = false;
				turnsSinceReminder = 0;
				remindersSent += 1;
				return reminderText(reentry);
			}
			turnsSinceReminder += 1;
			if (turnsSinceReminder < PLAN_REMINDER_EVERY_TURNS) return undefined;
			turnsSinceReminder = 0;
			remindersSent += 1;
			return reminderText();
		},
		onCompacted() {
			reannounce = true;
		},
	};
}
