import { listJobIds, type PermissionMode, readMeta } from "@kea/core";
import { Journal } from "@kea/research";
import { sparkline } from "../commands/evaluator-trend.ts";
import { InfoPanel } from "../components/dialogs/info-panel.ts";
import { type EvaluatorStat, type JobRow, pickBest, TasksPanel } from "../components/dialogs/tasks-panel.ts";
import { CURRENT_MARK } from "../constants/symbols.ts";
import type { TUICtx } from "../ctx.ts";
import { FilterablePicker, type PickerItem, pickerTheme } from "../picker.ts";
import { acquireSessionLock, releaseSessionLock, releaseSessionLocksExcept } from "../utils/session-lock.ts";

export function showPicker(
	ctx: TUICtx,
	items: PickerItem[],
	headerText: string,
	onPick: (value: string) => void,
): void {
	if (items.length === 0) {
		ctx.showStatus(`${headerText}: no options`);
		return;
	}
	const styles = ctx.styles();
	const picker = new FilterablePicker(
		items,
		pickerTheme(styles),
		{
			onPick: (value) => {
				ctx.restoreEditor();
				onPick(value);
			},
			onCancel: () => ctx.restoreEditor(),
		},
		(filter) =>
			`${styles.bold(` ${headerText} `)}${styles.faint(
				`· type to filter${filter !== "" ? `: "${filter}"` : ""} · ↑↓ navigate · Enter select · Esc cancel`,
			)}`,
		12,
		styles.primary,
	);
	ctx.mountDialog(picker);
}

export function openUndoSelector(ctx: TUICtx, choices: PickerItem[], onPick: (value: string) => void): void {
	showPicker(ctx, choices, "Undo", onPick);
}

export function openSessionsPicker(ctx: TUICtx): void {
	void (async () => {
		const sessions = await ctx.kernel.sessions.list();
		const items = sessions.slice(0, 30).map((s) => ({
			value: s.id,
			label: s.id,
			description: `${s.id === ctx.kernel.sessionId ? `${CURRENT_MARK} · ` : ""}${new Date(s.modifiedAt).toISOString().slice(0, 16).replace("T", " ")} · ${(s.metadata?.model as string | undefined) ?? ""}`,
		}));
		showPicker(ctx, items, "Switch session", async (id) => {
			if (ctx.kernel.agent.state.isStreaming) {
				ctx.showStatus("Cannot switch session while streaming", "warning");
				return;
			}
			if (id === ctx.kernel.sessionId) return;
			const target = sessions.find((s) => s.id === id);
			if (target === undefined) return;
			// single-writer discipline: a second process appending to one session corrupts the seq/parent chain
			const lock = acquireSessionLock(target.path);
			if (!lock.acquired) {
				ctx.showStatus(lock.reason ?? "session is locked by another process", "error");
				return;
			}
			void ctx.kernel
				.switchSession(target)
				.then(() => {
					// Registry-based release: every previously held lock (any intermediate session from a
					// rapid double-switch) goes away except the one now current.
					releaseSessionLocksExcept(target.path);
					ctx.showStatus(`Switched session: ${id.slice(0, 8)}… (transcript redrawn)`, "success");
				})
				.catch((err: unknown) => {
					// Roll back only our own attempt — the old session's lock stays held (we keep writing it).
					releaseSessionLock(target.path);
					// switchSession does session IO (open/replay): a corrupted ledger rejects, and an
					// unhandled rejection would kill the whole TUI.
					ctx.showStatus(`Session switch failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				});
		});
	})();
}

function openValuePicker<T extends string>(
	ctx: TUICtx,
	title: string,
	options: ReadonlyArray<{ value: T; hint: string }>,
	current: string,
	onApply: (value: T) => void,
): void {
	showPicker(
		ctx,
		options.map((o) => ({
			value: o.value,
			label: o.value,
			description: current === o.value ? `${CURRENT_MARK} · ${o.hint}` : o.hint,
		})),
		title,
		(value) => onApply(value as T),
	);
}

const PERMISSION_OPTIONS: ReadonlyArray<{ value: PermissionMode; hint: string }> = [
	{ value: "manual", hint: "Approve every action yourself." },
	{ value: "auto", hint: "Fully autonomous — agent decides everything without asking." },
	{ value: "yolo", hint: "Auto-approve tool actions, but the agent may still ask questions." },
];

export function openPermissionPicker(ctx: TUICtx): void {
	openValuePicker(ctx, "Permission mode", PERMISSION_OPTIONS, ctx.kernel.permissionMode, (mode) => {
		ctx.kernel.setPermissionMode(mode);
		ctx.showStatus(`Permission mode: ${mode}`, "success");
	});
}

export async function readJobRows(cwd: string): Promise<JobRow[]> {
	const ids = await listJobIds(cwd);
	const rows: JobRow[] = [];
	for (const id of ids.slice(-30)) {
		const meta = await readMeta(cwd, id);
		if (!meta) continue;
		const elapsed = meta.settledAt ? meta.settledAt - meta.submittedAt : Date.now() - meta.submittedAt;
		rows.push({
			id,
			backend: meta.backend,
			state: meta.state,
			elapsedSec: Math.round(elapsed / 1000),
			label: meta.label,
			lastError: meta.lastError,
		});
	}
	return rows;
}

export async function readEvaluatorStats(cwd: string): Promise<EvaluatorStat[]> {
	const glob = new Bun.Glob("*.json");
	const files: string[] = [];
	try {
		for await (const f of glob.scan({ cwd: `${cwd}/.kea/evaluators`, onlyFiles: true })) files.push(f);
	} catch {
		return [];
	}
	const stats: EvaluatorStat[] = [];
	for (const f of files) {
		try {
			const frozen = (await Bun.file(`${cwd}/.kea/evaluators/${f}`).json()) as {
				version: number;
				contract: { name: string; metric: { name: string; direction: string } };
			};
			const journal = new Journal(cwd);
			let events: Array<{ payload: { mean?: unknown } }>;
			try {
				events = journal.list({ type: "run_recorded", refId: frozen.contract.name, limit: 1000 });
			} finally {
				// Journal holds a bun:sqlite Database — never leak one per /tasks render.
				journal.close();
			}
			const means = events
				.map((e) => e.payload.mean)
				.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
			const chronological = [...means].reverse();
			stats.push({
				name: frozen.contract.name,
				version: frozen.version,
				metric: frozen.contract.metric.name,
				direction: frozen.contract.metric.direction,
				runs: events.length,
				best: pickBest(means, frozen.contract.metric.direction),
				trend: sparkline(chronological.slice(-24)),
			});
		} catch {
			// Skip a single corrupted contract without blocking the panel.
		}
	}
	return stats;
}

export async function openTasksPanel(ctx: TUICtx): Promise<TasksPanel | undefined> {
	const cwd = process.cwd();
	const [rows, stats] = await Promise.all([readJobRows(cwd), readEvaluatorStats(cwd)]);
	if (rows.length === 0 && stats.length === 0) {
		ctx.showStatus("No experiment jobs (they appear here after run_experiment submits one)");
		return undefined;
	}
	const panel = new TasksPanel(rows, ctx.styles(), cwd.split("/").pop() ?? "project", stats);
	panel.onClose = () => ctx.restoreEditor();
	ctx.mountDialog(panel);
	return panel;
}

export function openInfoPanel(ctx: TUICtx, title: string, lines: string[]): void {
	if (lines.length === 0) {
		ctx.showStatus(`${title}: nothing here yet`);
		return;
	}
	const panel = new InfoPanel(ctx.styles(), title, lines, () => ctx.restoreEditor());
	ctx.mountDialog(panel);
}

type ThinkingEffort = "off" | "minimal" | "low" | "medium" | "high";

const EFFORT_OPTIONS: ReadonlyArray<{ value: ThinkingEffort; hint: string }> = [
	{ value: "off", hint: "No thinking" },
	{ value: "minimal", hint: "Minimal" },
	{ value: "low", hint: "Low" },
	{ value: "medium", hint: "Medium (default)" },
	{ value: "high", hint: "High (slower but deeper)" },
];

export function openEffortPicker(ctx: TUICtx): void {
	openValuePicker(ctx, "Thinking effort", EFFORT_OPTIONS, ctx.kernel.agent.state.thinkingLevel ?? "medium", (level) => {
		ctx.kernel.setThinking(level);
		ctx.showStatus(`Thinking effort: ${level}`, "success");
	});
}
