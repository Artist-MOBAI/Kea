import { rm } from "node:fs/promises";
import {
	CONFIRM_WINDOW_MS,
	CORE_VERSION,
	createExecutionEnv,
	type Kernel,
	type PermissionMode,
	PI_STACK_VERSION,
} from "@kea/core";
import {
	checkMobaiIn,
	checkProgram,
	loadMobaiIn,
	loadProgram,
	mobaiPathIn,
	pickNext,
	removeProgram,
} from "@kea/research";
import { projectConfigPath, saveConfig } from "../../config.ts";
import { programFormalizationPrompt } from "../../program-formalize.ts";

// Re-export: app.ts and tests import the prompt from this module.
export { programFormalizationPrompt };

import { formatTokens } from "../constants/format.ts";
import { FAILURE_MARK, SUCCESS_MARK } from "../constants/symbols.ts";
import { sessionMobaiDir } from "../mobai-dir.ts";
import { isMobaiPaused, loadQueue, pauseMobai, resumeMobai, saveQueue } from "../mobai-lifecycle.ts";
import { acquireSessionLock, releaseSessionLocksExcept } from "../utils/session-lock.ts";
import { handleContext, handleDoctor, handleMcp, showPanel } from "./handlers-info.ts";
import { handleCopy, handleExportDebugZip, handleExportMd, handleUndo } from "./handlers-session.ts";
import { resolveSlashCommandInput } from "./resolve.ts";

/** Two-step /mobai cancel confirmations: mobaiDir → first-press timestamp. */
const cancelConfirmations = new Map<string, number>();

/** Reminder after /mobai cancel: stale active-mobai prompts must not resurrect the dead objective. */
export const MOBAI_CANCELLED_REMINDER =
	"The user cancelled the current mobai objective. Ignore any earlier active-mobai reminders and continuation prompts about it; do not resume the cancelled objective unless the user explicitly asks.";

/** Reminder after /mobai replace: earlier reminders describe the OLD objective. */
export const MOBAI_REPLACED_REMINDER =
	"The user replaced the mobai objective. Earlier mobai reminders refer to the OLD objective; ignore them — the new objective is being formalized now.";

// Mobai superseded (cancel/replace): remind the model at the next idle request so stale continuation
// prompts don't resurrect the old objective. appendSystemReminder is a no-op mid-run, so fall back
// to a visible status line instead of waiting.
async function remindMobaiSuperseded(host: SlashCommandHost, kernel: Kernel, text: string): Promise<void> {
	if (host.isStreaming()) {
		host.showStatus(text);
		return;
	}
	try {
		await kernel.appendSystemReminder(text);
	} catch {
		host.showStatus(text);
	}
}

function formatDuration(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
}

// Mobai-starting submissions need an idle kernel: mid-stream they would fail (re-entrancy) with the
// objective lost to a dead prompt.
function refuseMobaiStartWhileStreaming(host: SlashCommandHost): boolean {
	if (!host.isStreaming()) return false;
	host.showError("Cannot start a mobai while streaming — press Esc or Ctrl-C to interrupt, then rerun when idle");
	return true;
}

const MAX_MOBAI_OBJECTIVE_CHARS = 4000;

// One shared guard for every objective-submission inlet (create/replace/next immediate-start).
function refuseOverlongObjective(host: SlashCommandHost, objective: string): boolean {
	if (objective.length <= MAX_MOBAI_OBJECTIVE_CHARS) return false;
	host.showError(
		`Mobai objective is too long (max ${MAX_MOBAI_OBJECTIVE_CHARS} characters). Reference long details by file path.`,
	);
	return true;
}

import type { CommandIntent, KeaSlashCommand, SlashCommandBusyReason, SlashCommandHost } from "./types.ts";

export type { SlashCommandHost } from "./types.ts";

export function usageBar(pct: number, width = 24): string {
	const clamped = Math.max(0, Math.min(pct, 100));
	const filled = Math.round((clamped / 100) * width);
	return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${clamped}%`;
}

export async function dispatchInput(
	host: SlashCommandHost,
	kernel: Kernel,
	input: string,
): Promise<{ handled: boolean }> {
	const busy: SlashCommandBusyReason | undefined = host.isStreaming()
		? "streaming"
		: host.isCompacting()
			? "compacting"
			: undefined;
	const intent: CommandIntent = resolveSlashCommandInput(input, busy);

	switch (intent.kind) {
		case "not-command":
			return { handled: false };
		case "blocked": {
			const msg =
				intent.reason === "compacting"
					? `Cannot /${intent.commandName} while compacting — wait for compaction to finish.`
					: `Cannot /${intent.commandName} while streaming — press Esc or Ctrl-C first.`;
			host.showStatus(msg);
			return { handled: true };
		}
		case "invalid":
			host.showError(
				intent.suggestion
					? `Unknown command /${intent.commandName} — did you mean /${intent.suggestion}?`
					: `Unknown command /${intent.commandName} (/help to list all)`,
			);
			return { handled: true };
		case "builtin":
			break;
	}

	const { command, args } = intent;
	try {
		await executeCommand(host, kernel, command, args);
	} catch (err) {
		host.showError(`/${command.name} failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	return { handled: true };
}

function parseModeToggle(args: string, currentlyOn: boolean, mode: PermissionMode): PermissionMode | undefined {
	const a = args.trim().toLowerCase();
	if (a === "on") return mode;
	if (a === "off") return "manual";
	if (a === "") return currentlyOn ? "manual" : mode;
	return undefined;
}

async function executeCommand(
	host: SlashCommandHost,
	kernel: Kernel,
	command: KeaSlashCommand,
	args: string,
): Promise<void> {
	switch (command.name) {
		case "help": {
			host.openHelpPanel();
			return;
		}
		case "model": {
			if (args === "") {
				host.openModelPicker();
				return;
			}
			if (args.toLowerCase() === "add") {
				host.runAddProviderFlow(true);
				return;
			}
			if (host.isStreaming()) {
				host.showError("Cannot switch models while streaming — press Esc or Ctrl-C first.");
				return;
			}
			try {
				const model = kernel.setModel(args);
				await saveConfig(projectConfigPath(host.cwd), { defaultModel: `${model.provider}/${model.id}` });
				host.showStatus(
					`${SUCCESS_MARK} Default model switched: ${model.provider}/${model.id} (takes effect next turn)`,
				);
			} catch (err) {
				host.showError(err instanceof Error ? err.message : String(err));
			}
			return;
		}
		case "provider": {
			host.openProviderManager();
			return;
		}
		case "effort": {
			const levels = ["off", "minimal", "low", "medium", "high"] as const;
			if (args === "") {
				host.openEffortPicker();
				return;
			}
			const level = levels.find((l) => l === args.toLowerCase());
			if (!level) {
				host.showError(`Invalid level "${args}", options: ${levels.join(", ")}`);
				return;
			}
			kernel.setThinking(level);
			host.showStatus(`${SUCCESS_MARK} Thinking level: ${level}`);
			return;
		}
		case "yolo": {
			const currently = kernel.permissionMode === "yolo";
			const a = args.trim().toLowerCase();
			if (a === "on" && currently) {
				host.showNotice("YOLO mode is already on");
				return;
			}
			if (a === "off" && !currently) {
				host.showNotice("YOLO mode is already off");
				return;
			}
			const target = parseModeToggle(args, currently, "yolo");
			if (target === undefined) {
				host.showError("Usage: /yolo [on|off]");
				return;
			}
			kernel.setPermissionMode(target);
			if (target === "yolo") {
				host.showNotice("YOLO mode: ON", "Tool actions auto-approved; the agent may still ask you questions.");
			} else {
				host.showNotice("YOLO mode: OFF");
			}
			return;
		}
		case "auto": {
			const currently = kernel.permissionMode === "auto";
			const a = args.trim().toLowerCase();
			if (a === "on" && currently) {
				host.showNotice("Auto mode is already on");
				return;
			}
			if (a === "off" && !currently) {
				host.showNotice("Auto mode is already off");
				return;
			}
			const target = parseModeToggle(args, currently, "auto");
			if (target === undefined) {
				host.showError("Usage: /auto [on|off]");
				return;
			}
			kernel.setPermissionMode(target);
			if (target === "auto") {
				host.showNotice("Auto mode: ON", "All actions auto-approved; the agent will not ask you questions.");
			} else {
				host.showNotice("Auto mode: OFF");
			}
			return;
		}
		case "permission": {
			if (args === "") {
				host.openPermissionPicker();
				return;
			}
			const modes = ["manual", "auto", "yolo"] as const;
			const mode = modes.find((m) => m === args.toLowerCase());
			if (!mode) {
				host.showError(`Invalid mode "${args}", options: ${modes.join(", ")}`);
				return;
			}
			kernel.setPermissionMode(mode);
			host.showStatus(`${SUCCESS_MARK} Permission mode: ${mode}`);
			return;
		}
		case "plan": {
			// Plan is orthogonal: toggles a separate planMode and leaves permission mode untouched.
			const isOn = kernel.planMode;
			const a = args.trim().toLowerCase();
			if (a === "clear") {
				// /plan clear empties the current plan file (idle only) and STAYS in plan mode —
				// leaving the mode is the toggle (Shift+Tab / /plan) or approving exit_plan_mode.
				if (host.isStreaming()) {
					host.showStatus("Cannot /plan clear while streaming — press Esc or Ctrl-C first.");
					return;
				}
				if (host.isCompacting()) {
					host.showStatus("Cannot /plan clear while compacting — wait for compaction to finish.");
					return;
				}
				if (!isOn) {
					host.showStatus("No active plan to clear (plan mode is off)");
					return;
				}
				const path = kernel.plan.active ? kernel.plan.path : undefined;
				if (path === undefined) {
					host.showStatus("No active plan to clear");
					return;
				}
				try {
					await Bun.write(path, "");
					host.showStatus(`${SUCCESS_MARK} Plan cleared (plan mode stays on; the plan file is empty)`);
				} catch (err) {
					host.showError(`Could not clear plan file: ${err instanceof Error ? err.message : String(err)}`);
				}
				return;
			}
			if (a === "on" && isOn) {
				host.showNotice("Plan mode is already on");
				return;
			}
			if (a === "off" && !isOn) {
				host.showNotice("Plan mode is already off");
				return;
			}
			if (a !== "" && a !== "on" && a !== "off") {
				host.showError("Usage: /plan [on|off|clear]");
				return;
			}
			const target = a === "on" ? true : a === "off" ? false : !isOn;
			kernel.setPlanMode(target);
			if (target) {
				host.showNotice("Plan mode: ON", "Read-only enforced (policy layer blocks writes/executions).");
			} else {
				host.showNotice("Plan mode: OFF");
			}
			return;
		}
		case "mcp":
			await handleMcp(host, kernel);
			return;

		case "context":
			handleContext(host, kernel);
			return;
		case "doctor":
			await handleDoctor(host);
			return;
		case "tasks": {
			host.openTasksPanel();
			return;
		}
		case "mobai": {
			const mobaiDir = sessionMobaiDir(host.cwd, kernel.sessionId);
			// `--` escape: an objective that BEGINS with a subcommand word (status/pause/cancel/…/next)
			// must not be parsed as that subcommand — `/mobai -- cancel the old rollout note …`
			const rawArgs = args.trim();
			const escaped = rawArgs.startsWith("--");
			const objectiveArgs = escaped ? rawArgs.slice(2).trim() : rawArgs;
			if (escaped && objectiveArgs === "") {
				host.showError("Usage: /mobai -- <objective> (the escaped objective must not be empty)");
				return;
			}
			const sub = escaped ? "__create__" : (objectiveArgs.split(/\s+/)[0] ?? "").toLowerCase();
			const rest = escaped ? objectiveArgs : objectiveArgs.slice(sub.length).trim();

			if (sub === "pause") {
				const program = await loadProgram(mobaiDir);
				const mobai = program ? undefined : await loadMobaiIn(mobaiDir);
				// Only an unsettled objective takes the marker: pausing a complete/exhausted one would
				// leave a ghost `paused` file that silently blocks the next objective's auto-continue.
				const pausable =
					program?.status === "active" ||
					program?.status === "blocked" ||
					mobai?.status === "active" ||
					mobai?.status === "blocked";
				if (!pausable) {
					host.showStatus("No active mobai objective to pause");
					return;
				}
				const changed = await pauseMobai(mobaiDir);
				host.onMobaiPaused?.(); // an in-flight escalation must not land into a paused mobai
				host.showStatus(changed ? "Mobai paused — auto-continue suspended (/mobai resume)" : "Mobai is already paused");
				return;
			}
			if (sub === "resume") {
				if (!(await resumeMobai(mobaiDir))) {
					host.showStatus("Mobai is not paused — /mobai resume only resumes a paused mobai");
					return;
				}
				host.showStatus("Mobai resumed");
				if (host.onMobaiResumed) {
					// Ignition goes through the scheduler: machine criteria check + single-focus round,
					// rendered as a dim auto-continue line (a control command must not become a user bubble).
					host.onMobaiResumed();
					return;
				}
				host.submitPrompt(
					"Continue working toward the objective in the same session. Treat the workspace, program ledger, and journal as authoritative; make concrete load-bearing progress and record it.",
					{ rearm: false, display: "system" },
				);
				return;
			}
			if (sub === "cancel") {
				const program = await loadProgram(mobaiDir);
				const mobai = program ? undefined : await loadMobaiIn(mobaiDir);
				if (!program && !mobai) {
					host.showStatus("No active mobai objective to cancel");
					return;
				}
				// Cancellation cannot be resumed → two-step confirm within a short window.
				const last = cancelConfirmations.get(mobaiDir) ?? 0;
				if (Date.now() - last > CONFIRM_WINDOW_MS) {
					cancelConfirmations.set(mobaiDir, Date.now());
					host.showStatus(
						`This removes the mobai objective AND its ledger — run /mobai cancel again within ${Math.round(CONFIRM_WINDOW_MS / 1000)}s to confirm`,
					);
					return;
				}
				cancelConfirmations.delete(mobaiDir);
				if (program) await removeProgram(mobaiDir);
				else await rm(mobaiPathIn(mobaiDir), { force: true });
				await resumeMobai(mobaiDir); // also clears any paused marker
				host.onMobaiLedgerChanged?.();
				await remindMobaiSuperseded(host, kernel, MOBAI_CANCELLED_REMINDER);
				host.showNotice(
					"Mobai canceled",
					"The mobai ledger was removed; queued objectives are kept (/mobai next list)",
				);
				return;
			}
			if (sub === "replace") {
				if (rest === "") {
					host.showError("Usage: /mobai replace <objective>");
					return;
				}
				if (refuseOverlongObjective(host, rest)) return; // before the old ledger is removed
				const program = await loadProgram(mobaiDir);
				if (program) await removeProgram(mobaiDir);
				else await rm(mobaiPathIn(mobaiDir), { force: true });
				await resumeMobai(mobaiDir);
				host.onMobaiLedgerChanged?.();
				await remindMobaiSuperseded(host, kernel, MOBAI_REPLACED_REMINDER);
				if (host.isStreaming()) {
					// Intercept semantics hold mid-run (the old ledger is gone), but a mid-stream submit
					// would die on the re-entrancy guard — the new objective needs a rerun when idle.
					host.showNotice("Mobai replaced", "old objective removed — rerun /mobai <objective> when idle");
					return;
				}
				host.showNotice("Mobai replaced", "The previous ledger was removed; formalizing the new objective now");
				host.submitPrompt(programFormalizationPrompt(rest), { display: "system", echo: `/mobai replace ${rest}` });
				return;
			}
			if (sub === "next") {
				const restLc = rest.toLowerCase();
				if (rest === "" || restLc === "list") {
					const objectives = await loadQueue(mobaiDir);
					if (objectives.length === 0) {
						host.showStatus("No queued objectives — /mobai next <objective> to queue one");
						return;
					}
					host.openInfoPanel(
						"Queued objectives (/mobai next)",
						objectives.map((o, i) => `${i + 1}. ${o}`).concat("", "remove with /mobai next remove <n>"),
					);
					return;
				}
				if (restLc === "remove" || /^remove\s/.test(restLc)) {
					const n = Number(rest.split(/\s+/)[1]);
					const objectives = await loadQueue(mobaiDir);
					if (!Number.isInteger(n) || n < 1 || n > objectives.length) {
						host.showStatus(`Index out of range — queue has ${objectives.length} mobai(s)`);
						return;
					}
					const removed = objectives.splice(n - 1, 1)[0] ?? "";
					await saveQueue(mobaiDir, objectives);
					host.onMobaiLedgerChanged?.();
					host.showStatus(`Removed queued objective ${n}: ${removed.slice(0, 60)}`);
					return;
				}
				if (restLc === "clear") {
					await saveQueue(mobaiDir, []);
					host.onMobaiLedgerChanged?.();
					host.showStatus("Mobai queue cleared");
					return;
				}
				// Queue it, or start immediately when nothing is active.
				const objective = rest;
				const program = await loadProgram(mobaiDir);
				const mobai = program ? undefined : await loadMobaiIn(mobaiDir);
				if (!program && !mobai) {
					if (refuseOverlongObjective(host, objective)) return;
					if (refuseMobaiStartWhileStreaming(host)) return;
					host.showStatus("No active mobai objective — starting it now");
					host.submitPrompt(programFormalizationPrompt(objective), {
						display: "system",
						echo: `/mobai next ${objective}`,
					});
					return;
				}
				const objectives = await loadQueue(mobaiDir);
				objectives.push(objective);
				await saveQueue(mobaiDir, objectives);
				host.showStatus(`Queued (position ${objectives.length}) — starts when the current mobai objective completes`);
				return;
			}

			// Program mode first: program.json in this session's mobai dir wins over legacy mobai.json.
			const program = await loadProgram(mobaiDir);
			if (program) {
				if (sub === "check") {
					const { env } = await createExecutionEnv(host.cwd);
					const results = await checkProgram(host.cwd, env, program, (cmd) => kernel.reviewMobaiCommand(cmd));
					const lines = results.map((r) => `${r.passed ? SUCCESS_MARK : FAILURE_MARK} ${r.description} (${r.detail})`);
					const decision = pickNext(program);
					const next =
						decision.kind === "node"
							? `next: ${decision.node.id} — ${decision.node.title}`
							: `scheduler: ${decision.kind}`;
					showPanel(host, "Program check", [
						`Objective: ${program.objective}`,
						`Status: ${program.status} | nodes: ${program.nodes.filter((n) => n.status === "proved").length}/${program.nodes.length} proved | ${next}`,
						...lines,
					]);
					return;
				}
				if (sub === "clear") {
					const removed = await removeProgram(mobaiDir);
					// A stale paused marker must not intercept the next objective started in this session.
					await resumeMobai(mobaiDir);
					host.onMobaiLedgerChanged?.();
					host.showStatus(removed ? `${SUCCESS_MARK} Program cleared` : "No program to clear");
					return;
				}
				if (sub === "" || sub === "status") {
					const decision = pickNext(program);
					const paused = await isMobaiPaused(mobaiDir);
					const queued = (await loadQueue(mobaiDir)).length;
					const nodes = program.nodes.map(
						(n) =>
							`${n.status === "proved" ? SUCCESS_MARK : n.status === "refuted" ? FAILURE_MARK : "·"} ${n.id} [${n.kind}] ${n.title}`,
					);
					// Telemetry: turns from the journal, elapsed from the first entry, tokens from kernel usage.
					const turns = program.journal.reduce((m, e) => Math.max(m, e.round), 0);
					const startedAt = program.startedAt ?? program.journal[0]?.at ?? program.updatedAt;
					const elapsedMs = Math.max(0, Date.now() - startedAt);
					const tokens = kernel.usage().tokens;
					showPanel(host, "Program", [
						`Objective: ${program.objective}`,
						`Status: ${program.status}${paused ? " (PAUSED — /mobai resume)" : ""} | nodes: ${program.nodes.filter((n) => n.status === "proved").length}/${program.nodes.length} proved`,
						`Turns: ${turns} | Elapsed: ${formatDuration(elapsedMs)} | Total tokens used: ${tokens}`,
						decision.kind === "node"
							? `Next scheduled: ${decision.node.id} — ${decision.node.title}`
							: `Scheduler: ${decision.kind}`,
						...nodes,
						queued > 0
							? `Queued objectives: ${queued} (/mobai next list)`
							: "Run /mobai check to evaluate the program criteria",
					]);
					return;
				}
				if (refuseOverlongObjective(host, objectiveArgs)) return;
				// Exhausted programs may be re-formalized; only active/blocked are rejected.
				if (program.status === "active" || program.status === "blocked") {
					host.showError(
						"An unfinished program already exists in this session — /mobai clear to abandon it first, or /mobai status to inspect.",
					);
					return;
				}
				if (refuseMobaiStartWhileStreaming(host)) return;
				// A stale paused marker left by the settled program must not block the new objective.
				await resumeMobai(mobaiDir);
				host.submitPrompt(programFormalizationPrompt(objectiveArgs), {
					display: "system",
					echo: `/mobai ${objectiveArgs}`,
				});
				host.showStatus("Program formalization requested — the agent will call start_program");
				return;
			}
			if (sub === "check") {
				const mobai = await loadMobaiIn(mobaiDir);
				if (!mobai) {
					host.showStatus("No active mobai objective for this session");
					return;
				}
				const { env } = await createExecutionEnv(host.cwd);
				const { mobai: checked, results } = await checkMobaiIn(host.cwd, mobaiDir, env, (cmd) =>
					kernel.reviewMobaiCommand(cmd),
				);
				if (checked.status === "complete") {
					host.onMobaiLedgerChanged?.();
					host.onMobaiCompleted?.(mobai.objective);
				}
				const lines = results.map((r) => `${r.passed ? SUCCESS_MARK : FAILURE_MARK} ${r.description} (${r.detail})`);
				showPanel(host, "Mobai check", [`Mobai: ${mobai.objective}`, `Status: ${checked.status}`, ...lines]);
				return;
			}
			if (sub === "clear") {
				const mobai = await loadMobaiIn(mobaiDir);
				if (!mobai) {
					host.showStatus("No mobai to clear");
					return;
				}
				// clear is "abandon", not complete — it does not violate the "only check_goal sets complete" contract.
				await rm(mobaiPathIn(mobaiDir), { force: true });
				// A stale paused marker must not intercept the next objective started in this session.
				await resumeMobai(mobaiDir);
				host.onMobaiLedgerChanged?.();
				host.showStatus(`${SUCCESS_MARK} Mobai cleared`);
				return;
			}
			if (sub === "" || sub === "status") {
				const mobai = await loadMobaiIn(mobaiDir);
				if (!mobai) {
					host.showStatus("No active mobai objective — /mobai <objective> to start one");
					return;
				}
				// Read-only: do not run checkMobai (it would set complete and persist once all criteria pass); reading status must have no side effects.
				showPanel(host, "Mobai", [
					`Mobai: ${mobai.objective}`,
					`Status: ${mobai.status}`,
					`Updated: ${new Date(mobai.updatedAt).toISOString()}`,
					`Criteria: ${mobai.criteria.length} — run /mobai check to evaluate`,
				]);
				return;
			}
			// Default: /mobai <objective>. Reject immediately when this session already has an active mobai —
			// injecting a start_goal prompt would otherwise fail later with no feedback (single mobai per session).
			if (refuseOverlongObjective(host, objectiveArgs)) return;
			const active = await loadMobaiIn(mobaiDir);
			if (active && active.status !== "complete") {
				host.showError(
					"An active mobai already exists in this session — /mobai clear to abandon it first, or /mobai status to inspect.",
				);
				return;
			}
			if (refuseMobaiStartWhileStreaming(host)) return;
			// A stale paused marker left by the settled mobai must not block the new objective.
			await resumeMobai(mobaiDir);
			host.submitPrompt(programFormalizationPrompt(objectiveArgs), {
				display: "system",
				echo: `/mobai ${objectiveArgs}`,
			});
			host.showStatus("Program formalization requested — the agent will call start_program");
			return;
		}
		case "undo":
			handleUndo(host, kernel, args);
			return;
		case "fork": {
			// kimi-style no-switch fork: the copy lands in a new ledger, but the live conversation, lock,
			// and mobai state stay with the current session (no switchSession, no session_switched).
			const msgs = kernel.agent.state.messages.filter((m) => "role" in m);
			const fork = await kernel.sessions.create(`${kernel.model.provider}/${kernel.model.id}`);
			const systemPrompt = await kernel.sessions.readSystemPrompt(kernel.session);
			if (systemPrompt !== undefined) await kernel.sessions.recordSystemPrompt(fork, systemPrompt);
			await kernel.sessions.append(fork, msgs);
			const id = (await fork.getMetadata()).id;
			host.showStatus(`${SUCCESS_MARK} Forked to ${id.slice(0, 8)} — use /sessions to switch`);
			return;
		}
		case "settings": {
			host.openSettingsPanel();
			return;
		}
		case "new": {
			const id = await kernel.newSession();
			// single-writer discipline: this process writes the new session from here on; locks for any
			// prior session it still held go away (registry keeps exactly the current session).
			const created = await kernel.session.getMetadata();
			const lock = acquireSessionLock(created.path);
			if (!lock.acquired) {
				host.showError(lock.reason ?? "session is locked by another process");
				return;
			}
			releaseSessionLocksExcept(created.path);
			host.showStatus(`${SUCCESS_MARK} New session ${id}`);
			return;
		}
		case "sessions": {
			host.openSessionsPicker();
			return;
		}
		case "title": {
			const path = `${host.cwd}/.kea/session-titles.json`;
			const file = Bun.file(path);
			const map: Record<string, string> = (await file.exists()) ? await file.json() : {};
			if (args === "") {
				const current = map[kernel.sessionId];
				host.showStatus(current ? `Session title: ${current}` : "No title set — /title <title>");
				return;
			}
			map[kernel.sessionId] = args;
			await Bun.write(path, JSON.stringify(map, null, 2));
			host.showStatus(`${SUCCESS_MARK} Session title: ${args}`);
			return;
		}
		case "compact": {
			const outcome = await kernel.compactNow(args.trim() || undefined);
			host.showStatus(
				outcome.applied
					? `${SUCCESS_MARK} Context compacted`
					: `Not compacted: ${outcome.reason ?? "conditions not met"}`,
			);
			return;
		}
		case "copy":
			handleCopy(host);
			return;
		case "export-md":
			await handleExportMd(host, kernel, args);
			return;
		case "export-debug-zip":
			await handleExportDebugZip(host);
			return;
		case "usage": {
			const usage = kernel.usage();
			const estimate = kernel.contextTokens();
			const window = kernel.contextWindow;
			const pct = window > 0 ? Math.round((estimate / window) * 100) : 0;
			showPanel(host, "Usage", [
				`Context  ${usageBar(pct)}  ${formatTokens(estimate)} / ${formatTokens(window)}`,
				`Total spend  ${formatTokens(usage.tokens)} tokens · $${usage.usd.toFixed(4)}`,
				pct > 90
					? "Context near the limit, /compact recommended"
					: pct > 70
						? "Context is getting high, watch for the right /compact moment"
						: "Context headroom is ample",
			]);
			return;
		}
		case "status": {
			showPanel(host, "Runtime status", [
				`Model: ${kernel.model.provider}/${kernel.model.id}`,
				`Session: ${kernel.sessionId}`,
				`Workspace trust: ${kernel.trusted ? "trusted (project MCP loaded)" : "not trusted (project MCP not loaded)"}`,
				`Messages: ${kernel.agent.state.messages.length}`,
				`Version: kea ${CORE_VERSION}`,
			]);
			return;
		}
		case "version": {
			host.showStatus(`kea ${CORE_VERSION} · pi-stack ${PI_STACK_VERSION}`);
			return;
		}
		case "reload": {
			await kernel.reloadPolicy();
			host.showStatus(`${SUCCESS_MARK} execpolicy reloaded`);
			return;
		}
		case "exit": {
			host.exit();
			return;
		}
		default: {
			// Fallback when a newly registered command is not wired: never silently no-op.
			host.showError(`Command /${command.name} is not wired in the dispatcher (report this bug)`);
			return;
		}
	}
}

export { trimToSafeBoundary } from "./handlers-session.ts";
