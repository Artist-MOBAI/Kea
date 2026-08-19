import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "../../constants/format.ts";
import { AWAITING_MARK, RUNNING_MARK, STATUS_BULLET } from "../../constants/symbols.ts";
import type { ThemeStyles } from "../../theme.ts";

export interface MobaiSnapshot {
	objective: string;
	status: string;
	elapsedMs?: number;
}

export interface FooterData {
	modelSpec: string;
	sessionId: string;
	permissionMode: string;
	planMode: boolean;
	contextPct: number;
	contextTokens: number;
	contextWindow: number;
	mobai?: MobaiSnapshot;
	runningJobs: number;
	awaitingJobs: number;
	steerQueued: number;
}

export function modeBadge(mode: string, styles: ThemeStyles): string {
	if (mode === "auto") return styles.warning(styles.bold("auto"));
	if (mode === "yolo") return styles.warning(styles.bold("yolo"));
	return "";
}

function mobaiDot(status: string, styles: ThemeStyles): string {
	if (status === "active") return styles.primary(STATUS_BULLET);
	if (status === "blocked") return styles.warning(STATUS_BULLET);
	return styles.dim(STATUS_BULLET);
}

function formatClock(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

export const FOOTER_TIPS = [
	"Ctrl+O expands tool output",
	"Ctrl+S steers mid-stream",
	"@ to mention files",
	"/tasks experiment jobs",
	"/model switch model",
	"/help all commands",
] as const;
const TIP_ROTATE_MS = 10_000;

export function renderFooter(data: FooterData, styles: ThemeStyles, width = 120, tip?: string): string {
	const parts: string[] = [];
	if (data.planMode) parts.push(styles.primary(styles.bold("plan")));
	const badge = modeBadge(data.permissionMode, styles);
	if (badge !== "") parts.push(badge);
	if (data.mobai) {
		const elapsed = data.mobai.elapsedMs !== undefined ? ` · ${formatClock(data.mobai.elapsedMs)}` : "";
		parts.push(
			`${styles.dim("[mobai ")}${mobaiDot(data.mobai.status, styles)}${styles.dim(` ${data.mobai.status}${elapsed}]`)}`,
		);
	}
	parts.push(styles.primary(styles.bold(data.modelSpec)));
	if (data.runningJobs > 0)
		parts.push(styles.accent(`${RUNNING_MARK} ${data.runningJobs} job${data.runningJobs > 1 ? "s" : ""}`));
	if (data.awaitingJobs > 0) parts.push(styles.warning(`${AWAITING_MARK} ${data.awaitingJobs} awaiting backfill`));
	let line1 = parts.join(" ");
	line1 += styles.dim(` · ${data.sessionId.slice(0, 8)}`);
	if (tip) {
		// The tip is right-aligned; when the left badge is too long, trim the left side first.
		const tipStyled = styles.faint(tip);
		const gap = Math.max(1, width - visibleWidth(line1) - visibleWidth(tip));
		line1 = `${truncateToWidth(line1, Math.max(8, width - visibleWidth(tip) - 1), "…")}${" ".repeat(gap)}${tipStyled}`;
	}
	line1 = truncateToWidth(line1, width, "…");

	const pct = data.contextPct;
	const pctText = pct > 90 ? styles.error(`${pct}%`) : pct > 70 ? styles.warning(`${pct}%`) : `${pct}%`;
	const usage =
		data.contextWindow > 0 ? ` (${formatTokens(data.contextTokens)}/${formatTokens(data.contextWindow)})` : "";
	const right = styles.dim(`context: ${pctText}${usage}`);

	let left = "";
	if (data.steerQueued > 0) left = styles.warning(`${data.steerQueued} queued`);
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	const line2 = `${left}${" ".repeat(gap)}${right}`;
	return `${line1}\n${truncateToWidth(line2, width, "…")}`;
}

export class FooterView {
	readonly component: Text;
	private data?: FooterData;
	private styles?: ThemeStyles;
	private width = 120;
	private transientHint = "";
	private transientStyle: ((s: string) => string) | undefined;
	private hintTimer?: ReturnType<typeof setTimeout>;
	private tipIndex = 0;
	private readonly tipTimer: ReturnType<typeof setInterval>;

	constructor(styles: ThemeStyles, initial?: FooterData) {
		this.component = new Text(initial ? renderFooter(initial, styles) : "", 0, 0);
		this.tipTimer = setInterval(() => {
			this.tipIndex += 1;
			this.redraw();
		}, TIP_ROTATE_MS);
		this.tipTimer.unref?.();
	}

	setData(data: FooterData, styles: ThemeStyles, width?: number): void {
		this.data = data;
		this.styles = styles;
		if (width !== undefined) this.width = width;
		this.redraw();
	}

	setTransientHint(text: string, style: (s: string) => string, ttlMs: number): void {
		this.transientHint = text;
		this.transientStyle = style;
		if (this.hintTimer !== undefined) clearTimeout(this.hintTimer);
		this.hintTimer = setTimeout(() => {
			this.transientHint = "";
			this.hintTimer = undefined;
			this.redraw();
		}, ttlMs);
		this.hintTimer.unref?.();
		this.redraw();
	}

	dispose(): void {
		clearInterval(this.tipTimer);
		if (this.hintTimer !== undefined) clearTimeout(this.hintTimer);
		this.hintTimer = undefined;
	}

	private redraw(): void {
		if (!this.data || !this.styles) return;
		const tip = FOOTER_TIPS[this.tipIndex % FOOTER_TIPS.length];
		let text = renderFooter(this.data, this.styles, this.width, tip);
		if (this.transientHint !== "" && this.transientStyle) {
			text += `\n${this.transientStyle(truncateToWidth(this.transientHint, this.width, "…"))}`;
		}
		this.component.setText(text);
	}
}
