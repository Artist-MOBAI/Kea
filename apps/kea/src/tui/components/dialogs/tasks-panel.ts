import { type Component, type Focusable, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { AWAITING_MARK, FAILURE_MARK, RUNNING_MARK, SUCCESS_MARK } from "../../constants/symbols.ts";
import type { ThemeStyles } from "../../theme.ts";
import { printableKey } from "../../utils/printable-key.ts";

export interface JobRow {
	id: string;
	backend: string;
	state: string;
	elapsedSec: number;
	label?: string;
	lastError?: string;
}

export interface EvaluatorStat {
	name: string;
	version: number;
	metric: string;
	direction: string;
	runs: number;
	best?: number;
	trend?: string;
}

export function pickBest(values: readonly number[], direction: string): number | undefined {
	if (values.length === 0) return undefined;
	return direction === "minimize" ? Math.min(...values) : Math.max(...values);
}

function stateMark(state: string, styles: ThemeStyles): string {
	if (state === "awaiting_human") return styles.warning(AWAITING_MARK);
	if (state === "running" || state === "queued") return styles.accent(RUNNING_MARK);
	if (state === "completed") return styles.success(SUCCESS_MARK);
	return styles.error(FAILURE_MARK);
}

// awaiting_human always sorts to the top — "what should I do now" must be visible at first glance.
export function sortJobRows(rows: JobRow[]): JobRow[] {
	const weight = (r: JobRow): number =>
		r.state === "awaiting_human" ? 0 : r.state === "running" || r.state === "queued" ? 1 : 2;
	return [...rows].sort((a, b) => weight(a) - weight(b));
}

export class TasksPanel implements Component, Focusable {
	focused = false;
	onClose?: () => void;

	constructor(
		private rows: JobRow[],
		readonly styles: ThemeStyles,
		private readonly cwdLabel: string,
		private readonly stats: EvaluatorStat[] = [],
	) {}

	setRows(rows: JobRow[]): void {
		this.rows = rows;
	}

	invalidate(): void {
		// No render cache: recomputed on every render.
	}

	render(width: number): string[] {
		const { styles } = this;
		const lines = [styles.bold("experiment jobs") + styles.dim(` — ${this.cwdLabel} · Esc to close`)];
		if (this.stats.length > 0) {
			lines.push(styles.bold(" Experiment status"));
			for (const s of this.stats) {
				const best = s.best !== undefined ? ` · best=${s.best}` : "";
				const trend = s.trend !== undefined && s.trend !== "" ? ` · ${s.trend}` : "";
				const line = `  ${SUCCESS_MARK} ${s.name} v${s.version} · metric=${s.metric}(${s.direction}) · ${s.runs} runs${best}${trend}`;
				lines.push(truncateToWidth(styles.dim(line), width));
			}
			lines.push("");
		}
		const sorted = sortJobRows(this.rows);
		if (sorted.length === 0) {
			lines.push(styles.dim("  No experiment jobs (they appear here once run_experiment submits)"));
			return lines.map((line) => truncateToWidth(line, width));
		}
		for (const row of sorted) {
			const elapsed = `${row.elapsedSec}s`;
			const label = row.label ? ` · ${row.label}` : "";
			const line = ` ${stateMark(row.state, styles)} ${row.id.slice(0, 8)} [${row.backend}] ${row.state} · ${elapsed}${label}`;
			lines.push(
				row.state === "awaiting_human" ? styles.warning(truncateToWidth(line, width)) : truncateToWidth(line, width),
			);
			if (row.lastError) lines.push(truncateToWidth(styles.error(`   ${row.lastError}`), width));
		}
		if (sorted.some((r) => r.state === "awaiting_human")) {
			lines.push("");
			lines.push(styles.warning("A job awaits your result: run offline, then submit via submit_experiment_result"));
		}
		// pi-tui hard-crashes on over-width rows and dialogs mount without width protection: clamp each row.
		return lines.map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || printableKey(data).toLowerCase() === "q") this.onClose?.();
	}
}
