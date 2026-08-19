import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { TodoItem } from "@kea/core";
import { PENDING_MARK, STATUS_BULLET, SUCCESS_MARK } from "../../constants/symbols.ts";
import type { ThemeStyles } from "../../theme.ts";

// Fold algorithm: keep all in_progress, fill remaining slots with the earliest pending + the most
// recent done; Ctrl+T expands everything only on overflow.

export const TODO_MAX_VISIBLE = 5;

export function selectVisibleTodos(
	todos: readonly TodoItem[],
	maxVisible = TODO_MAX_VISIBLE,
): {
	visible: TodoItem[];
	hiddenCounts: { done: number; inProgress: number; pending: number };
} {
	if (todos.length <= maxVisible) {
		return { visible: [...todos], hiddenCounts: { done: 0, inProgress: 0, pending: 0 } };
	}
	const pick = new Set<number>();
	const byStatus = { in_progress: [] as number[], pending: [] as number[], done: [] as number[] };
	todos.forEach((t, i) => {
		byStatus[t.status].push(i);
	});

	for (const i of byStatus.in_progress.slice(0, maxVisible)) pick.add(i);

	const pendingCandidates = byStatus.pending;
	const doneCandidates = [...byStatus.done].reverse();
	let remaining = maxVisible - pick.size;
	if (remaining > 0) {
		if (pendingCandidates.length > 0 && doneCandidates.length > 0) {
			const doneCount = Math.min(1, doneCandidates.length, remaining);
			for (const i of doneCandidates.slice(0, doneCount)) pick.add(i);
			remaining -= doneCount;
			const pendingTake = Math.min(remaining, pendingCandidates.length);
			for (const i of pendingCandidates.slice(0, pendingTake)) pick.add(i);
			remaining -= pendingTake;
			if (remaining > 0) {
				for (const i of doneCandidates.slice(doneCount, doneCount + remaining)) pick.add(i);
			}
		} else {
			const candidates = pendingCandidates.length > 0 ? pendingCandidates : doneCandidates;
			for (const i of candidates.slice(0, remaining)) pick.add(i);
		}
	}

	const visible = todos.filter((_, i) => pick.has(i));
	const hiddenCounts = {
		done: byStatus.done.filter((i) => !pick.has(i)).length,
		inProgress: byStatus.in_progress.filter((i) => !pick.has(i)).length,
		pending: byStatus.pending.filter((i) => !pick.has(i)).length,
	};
	return { visible, hiddenCounts };
}

export function formatHiddenCounts(counts: { done: number; inProgress: number; pending: number }): string {
	const parts: string[] = [];
	if (counts.done > 0) parts.push(`${counts.done} done`);
	if (counts.inProgress > 0) parts.push(`${counts.inProgress} in progress`);
	if (counts.pending > 0) parts.push(`${counts.pending} pending`);
	return parts.join(" · ");
}

export class TodoPanel implements Component {
	private todos: TodoItem[] = [];
	private expanded = false;
	private renderCache: { width: number; lines: string[] } | undefined;

	constructor(readonly styles: ThemeStyles) {}

	setTodos(items: readonly TodoItem[]): void {
		this.todos = [...items];
		// Reset expanded when the list shrinks below the overflow line, or render would emit a
		// never-valid Ctrl+T collapse hint.
		if (this.todos.length <= TODO_MAX_VISIBLE) this.expanded = false;
		this.renderCache = undefined;
	}

	clear(): void {
		this.todos = [];
		this.expanded = false;
		this.renderCache = undefined;
	}

	hasOverflow(): boolean {
		return this.todos.length > TODO_MAX_VISIBLE;
	}

	toggleExpanded(): void {
		if (!this.hasOverflow()) return;
		this.expanded = !this.expanded;
		this.renderCache = undefined;
	}

	invalidate(): void {
		this.renderCache = undefined;
	}

	render(width: number): string[] {
		if (this.todos.length === 0) return [];
		if (this.renderCache !== undefined && this.renderCache.width === width) return this.renderCache.lines;

		const { styles } = this;
		// Invariant guarantees expanded ⇒ overflow: toggleExpanded only flips on overflow, setTodos/clear reset when shrinking
		const expanded = this.expanded;
		// The panel is mounted directly by the tui (no WidthSafe wrap): every row must be ≤ width, safe on narrow terminals
		const safeWidth = Math.max(0, width);
		const lines: string[] = [
			styles.border("─".repeat(safeWidth)),
			truncateToWidth(styles.primary(styles.bold("  Todo")), safeWidth, "…"),
		];

		const items = expanded ? this.todos : selectVisibleTodos(this.todos).visible;
		for (const item of items) lines.push(truncateToWidth(this.renderRow(item), safeWidth, "…"));

		if (!expanded && this.todos.length > TODO_MAX_VISIBLE) {
			const { hiddenCounts } = selectVisibleTodos(this.todos);
			const hidden = this.todos.length - items.length;
			lines.push(
				truncateToWidth(
					styles.dim(`  … +${hidden} more (${formatHiddenCounts(hiddenCounts)}) · Ctrl+T to expand`),
					safeWidth,
					"…",
				),
			);
		} else if (expanded) {
			lines.push(truncateToWidth(styles.dim(`  all ${this.todos.length} items · Ctrl+T to collapse`), safeWidth, "…"));
		}

		this.renderCache = { width, lines };
		return lines;
	}

	private renderRow(item: TodoItem): string {
		const { styles } = this;
		if (item.status === "in_progress") {
			return `  ${styles.primary(styles.bold(STATUS_BULLET))} ${styles.bold(item.title)}`;
		}
		if (item.status === "done") {
			return `  ${styles.success(SUCCESS_MARK)} ${styles.dim(item.title)}`;
		}
		return `  ${styles.dim(PENDING_MARK)} ${item.title}`;
	}
}
