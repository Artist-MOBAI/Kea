import { type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CURRENT_MARK, FAILURE_MARK, SELECT_POINTER, SUCCESS_MARK } from "../../constants/symbols.ts";
import type { ThemeStyles } from "../../theme.ts";
import { printableKey } from "../../utils/printable-key.ts";

export interface ProviderRow {
	id: string;
	source: string;
	baseUrl?: string;
	kind: "builtin" | "custom";
	isCurrent: boolean;
	/** Whether there are deletable credentials (stored key and/or models.json custom entry). */
	deletable: boolean;
	modelCount: number;
	models: Array<{ id: string; contextWindow: number }>;
	/** Wire API (custom: custom.api; builtin: first model's api) — determines the probe protocol. */
	api?: string;
	connectionStatus?: "verified" | "failed";
}

export interface ProviderPanelCallbacks {
	onAdd: () => void;
	onDelete: (row: ProviderRow) => void;
	onClose: () => void;
	onTestConnection?: (row: ProviderRow) => void;
	onEditBaseUrl?: (row: ProviderRow) => void;
}

const ADD_ROW_LABEL = "[ Add new provider ]";

type PanelMode = "list" | "detail";

export class ProviderPanel implements Component, Focusable {
	focused = false;
	private mode: PanelMode = "list";
	private selected = 0;
	private confirming: ProviderRow | undefined;
	private detailAction = 0;
	// Probe results (in-memory for the panel's lifetime); override row.connectionStatus's static value.
	private readonly probeResults = new Map<string, "verified" | "failed">();

	constructor(
		private rows: ProviderRow[],
		private readonly styles: ThemeStyles,
		private readonly callbacks: ProviderPanelCallbacks,
	) {}

	// Selection tracks by row id: the highlight stays on the same provider after a deletion;
	// only when the selected row itself is deleted does it fall back to an index clamp.
	setRows(rows: ProviderRow[]): void {
		const prevSelected = this.selected < this.rows.length ? this.rows[this.selected] : undefined;
		this.rows = rows;
		this.confirming = undefined;
		if (prevSelected === undefined) {
			this.selected = rows.length;
			return;
		}
		const idx = rows.findIndex((r) => r.id === prevSelected.id);
		this.selected = idx >= 0 ? idx : Math.min(this.selected, rows.length);
	}

	setProbeResult(providerId: string, status: "verified" | "failed" | undefined): void {
		if (status === undefined) this.probeResults.delete(providerId);
		else this.probeResults.set(providerId, status);
		this.invalidate();
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.mode === "detail") return this.renderDetail(width);
		return this.renderList(width);
	}

	private renderList(width: number): string[] {
		const s = this.styles;
		const lines: string[] = [s.primary("─".repeat(width)), s.bold(" Providers & credentials")];
		if (this.confirming) {
			lines.push(this.renderConfirm(this.confirming.id, width));
		} else {
			lines.push(s.faint(" · ↑↓ navigate · Enter details · Enter on Add to add · D delete · Esc close"));
		}
		if (this.rows.length === 0) {
			lines.push(s.dim(" No providers configured — press Enter to add one, or export *_API_KEY."));
		}
		for (let i = 0; i < this.rows.length; i++) {
			lines.push(this.renderRow(this.rows[i] as ProviderRow, i === this.selected));
		}
		lines.push(this.renderAddRow(this.selected === this.rows.length));
		lines.push(s.primary("─".repeat(width)));
		return lines.map((line) => truncateToWidth(line, width));
	}

	private renderRow(row: ProviderRow, selected: boolean): string {
		const s = this.styles;
		const pointer = selected ? s.primary(`${SELECT_POINTER} `) : "  ";
		const status = this.connectionIcon(row);
		const modelInfo = s.dim(` · ${row.modelCount} model${row.modelCount !== 1 ? "s" : ""}`);
		const idText = selected ? s.primary(s.bold(row.id)) : row.id;
		let text = `${status} ${idText}${modelInfo}`;
		if (row.source !== "") text += s.dim(` · ${row.source}`);
		if (row.baseUrl !== undefined) text += s.dim(` · ${row.baseUrl}`);
		if (row.isCurrent) text += s.dim(` ${CURRENT_MARK}`);
		return `${pointer}${text}`;
	}

	private effectiveStatus(row: ProviderRow): "verified" | "failed" | undefined {
		return this.probeResults.get(row.id) ?? row.connectionStatus;
	}

	private connectionIcon(row: ProviderRow): string {
		const status = this.effectiveStatus(row);
		if (status === "verified") return SUCCESS_MARK;
		if (status === "failed") return FAILURE_MARK;
		return "?";
	}

	private renderAddRow(selected: boolean): string {
		const s = this.styles;
		const pointer = selected ? s.primary(`${SELECT_POINTER} `) : "  ";
		return `${pointer}${selected ? s.primary(s.bold(ADD_ROW_LABEL)) : s.dim(ADD_ROW_LABEL)}`;
	}

	private renderDetail(width: number): string[] {
		const s = this.styles;
		const row = this.rows[this.selected];
		if (!row) return this.renderList(width);

		const lines: string[] = [s.primary("─".repeat(width))];

		const kindBadge = row.kind === "custom" ? s.dim("[custom]") : s.dim("[builtin]");
		lines.push(s.bold(` ${row.id} ${kindBadge}`));

		if (row.source !== "") lines.push(s.dim(`  Source: ${row.source}`));
		if (row.baseUrl !== undefined) lines.push(s.dim(`  Base URL: ${row.baseUrl}`));
		const status = this.connectionIcon(row);
		const effective = this.effectiveStatus(row);
		const statusLabel = effective === "verified" ? "verified" : effective === "failed" ? "failed" : "not tested";
		lines.push(s.dim(`  Connection: ${status} ${statusLabel}`));
		lines.push(s.dim(`  Models: ${row.modelCount}`));

		if (row.models.length > 0) {
			lines.push("");
			lines.push(s.faint("  Models:"));
			for (const m of row.models) {
				const ctxStr = m.contextWindow >= 1000 ? `${Math.round(m.contextWindow / 1000)}k` : `${m.contextWindow}`;
				const marker = row.isCurrent ? s.dim(` ${CURRENT_MARK}`) : "";
				lines.push(s.dim(`    ${m.id} · ctx ${ctxStr}${marker}`));
			}
		}

		lines.push("");

		lines.push(s.faint("  Actions:"));
		const actions = this.buildDetailActions(row);
		for (let i = 0; i < actions.length; i++) {
			const a = actions[i] as { label: string; key: string };
			const isSelected = i === this.detailAction;
			const pointer = isSelected ? s.primary(`${SELECT_POINTER} `) : "  ";
			const label = isSelected ? s.primary(s.bold(a.label)) : s.dim(a.label);
			lines.push(`${pointer}[${a.key}] ${label}`);
		}

		lines.push("");
		lines.push(s.faint("  Esc · back to list"));
		lines.push(s.primary("─".repeat(width)));
		return lines.map((line) => truncateToWidth(line, width));
	}

	private buildDetailActions(row: ProviderRow): Array<{ label: string; key: string }> {
		const actions: Array<{ label: string; key: string }> = [{ label: "Test connection", key: "T" }];
		if (row.kind === "custom") {
			actions.push({ label: "Edit base URL", key: "E" });
		}
		if (row.deletable) {
			actions.push({ label: "Delete", key: "D" });
		}
		return actions;
	}

	private renderConfirm(id: string, width: number): string {
		const s = this.styles;
		const suffix = "? [y/N]";
		const prefix = "Delete ";
		const full = `${prefix}${id}${suffix}`;
		if (visibleWidth(full) <= width) return s.warning(full);
		// [y/N] is always kept: on short space trim the id first, then the "Delete " prefix.
		const suffixW = visibleWidth(suffix);
		const prefixW = visibleWidth(prefix);
		const idBudget = width - suffixW;
		if (idBudget >= prefixW + 2) {
			const shown = truncateToWidth(id, idBudget - prefixW - 1, "…");
			return s.warning(`${prefix}${shown}${suffix}`);
		}
		const shown = idBudget >= 2 ? truncateToWidth(id, idBudget - 1, "…") : "";
		return s.warning(`${shown}${suffix}`);
	}

	handleInput(data: string): void {
		if (this.mode === "detail") {
			this.handleDetailInput(data);
			return;
		}
		this.handleListInput(data);
	}

	private handleListInput(data: string): void {
		if (this.confirming !== undefined) {
			const ch = printableKey(data).toLowerCase();
			if (ch === "y") {
				const row = this.confirming;
				this.confirming = undefined;
				this.callbacks.onDelete(row);
			} else if (ch === "n" || matchesKey(data, "escape")) {
				this.confirming = undefined;
			}
			this.invalidate();
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = this.selected <= 0 ? this.rows.length : this.selected - 1;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = this.selected >= this.rows.length ? 0 : this.selected + 1;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "enter")) {
			if (this.selected === this.rows.length) {
				this.callbacks.onAdd();
			} else if (this.selected < this.rows.length) {
				this.mode = "detail";
				this.detailAction = 0;
				this.invalidate();
			}
			return;
		}
		if (printableKey(data).toUpperCase() === "D") {
			const row = this.rows[this.selected];
			if (row?.deletable) {
				this.confirming = row;
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, "escape")) {
			this.callbacks.onClose();
		}
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.mode = "list";
			this.invalidate();
			return;
		}
		if (matchesKey(data, "up")) {
			const actions = this.buildDetailActions(this.rows[this.selected] as ProviderRow);
			this.detailAction = this.detailAction <= 0 ? actions.length - 1 : this.detailAction - 1;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "down")) {
			const actions = this.buildDetailActions(this.rows[this.selected] as ProviderRow);
			this.detailAction = this.detailAction >= actions.length - 1 ? 0 : this.detailAction + 1;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "enter")) {
			const row = this.rows[this.selected] as ProviderRow;
			const actions = this.buildDetailActions(row);
			const action = actions[this.detailAction];
			if (!action) return;
			if (action.key === "T") {
				this.callbacks.onTestConnection?.(row);
			} else if (action.key === "E") {
				this.callbacks.onEditBaseUrl?.(row);
			} else if (action.key === "D") {
				this.mode = "list";
				this.confirming = row;
				this.invalidate();
			}
			return;
		}
		const upper = printableKey(data).toUpperCase();
		if (upper === "T") {
			this.callbacks.onTestConnection?.(this.rows[this.selected] as ProviderRow);
		} else if (upper === "E") {
			const row = this.rows[this.selected] as ProviderRow;
			if (row.kind === "custom") this.callbacks.onEditBaseUrl?.(row);
		} else if (upper === "D") {
			const row = this.rows[this.selected] as ProviderRow;
			if (row.deletable) {
				this.mode = "list";
				this.confirming = row;
				this.invalidate();
			}
		}
	}
}
