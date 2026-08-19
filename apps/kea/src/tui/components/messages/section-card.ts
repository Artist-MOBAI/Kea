import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { BRANCH_BULLET, SPINNER_FRAMES } from "../../constants/symbols.ts";
import type { ThemeStyles } from "../../theme.ts";
import { MIN_WRAP_WIDTH, WidthCache } from "./render-cache.ts";

/** Truncates or space-pads to an exact visible width — pi-tui throws on over-width rows. */
function fitExactly(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w > width) return truncateToWidth(line, width, "…");
	if (w === width) return line;
	return `${line}${" ".repeat(width - w)}`;
}

// flushLeft: the implementer's first row left border renders as ├, joining the header ─ into the ├─ branch shape.
// junctionPaint: the ├ color belongs to the branch itself; defaults to the frame color.
export interface Flushable {
	readonly flushLeft: true;
	readonly junctionPaint?: (s: string) => string;
}

// Frame color lifecycle: border → accent while in progress → border at turn end (error on failure).
export class SectionCard implements Component {
	private readonly children: Component[] = [];
	private framePaint: (s: string) => string;
	private foldedCount = 0;
	private frameCache:
		| { width: number; paint: (s: string) => string; top: string; bottom: string; blankInner: string; side: string }
		| undefined;

	constructor(
		private readonly styles: ThemeStyles,
		readonly kind: "user" | "agent" = "agent",
		framePaint?: (s: string) => string,
	) {
		this.framePaint = framePaint ?? styles.border;
	}

	setFrame(paint: (s: string) => string): void {
		this.framePaint = paint;
	}

	addChild(child: Component): void {
		this.children.push(child);
	}

	getChildren(): readonly Component[] {
		return this.children;
	}

	get childCount(): number {
		return this.children.length;
	}

	// Always keeps the first child (the user message); folds older steps in between.
	foldOldChildren(keepRecent: number): number {
		const rest = this.children.length - 1;
		if (rest <= keepRecent) return 0;
		const removed = rest - keepRecent;
		this.children.splice(1, removed);
		this.foldedCount += removed;
		return removed;
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate?.();
	}

	render(width: number): string[] {
		if (this.children.length === 0) return [];
		const frame = this.framePaint;
		const safeWidth = Math.max(width, MIN_WRAP_WIDTH);
		// 2 columns of padding on each side: aligns body columns with the ├─ header text (starting at col 3).
		const pad = "  ";
		const innerWidth = Math.max(1, safeWidth - 2 - pad.length * 2);

		// Frame strings only change with (width, paint identity); setFrame swaps paint and naturally misses to recompute.
		let fc = this.frameCache;
		if (fc === undefined || fc.width !== safeWidth || fc.paint !== frame) {
			const rule = "─".repeat(Math.max(0, safeWidth - 2));
			const side = frame("│");
			fc = {
				width: safeWidth,
				paint: frame,
				top: frame(`╭${rule}╮`),
				bottom: frame(`╰${rule}╯`),
				blankInner: `${side}${" ".repeat(safeWidth - 2)}${side}`,
				side,
			};
			this.frameCache = fc;
		}
		const { top, bottom, blankInner, side } = fc;

		const lines: string[] = [top, blankInner];
		let hasContent = false;
		let foldEmitted = false;
		// The fold line follows the first child that rendered content; emitted at the end as a fallback —
		// folded steps never vanish silently.
		const emitFoldLine = () => {
			if (foldEmitted || this.foldedCount === 0) return;
			foldEmitted = true;
			const foldLine = this.styles.dim(`… ${this.foldedCount} earlier steps folded (full history in session ledger)`);
			lines.push(blankInner);
			lines.push(`${side}${pad}${fitExactly(foldLine, innerWidth)}${pad}${side}`);
		};
		for (const child of this.children) {
			const flush = (child as Partial<Flushable>).flushLeft === true;
			const childLines = child.render(innerWidth);
			if (childLines.length === 0) continue;
			if (flush && hasContent) lines.push(blankInner);
			childLines.forEach((line, i) => {
				if (flush && i === 0) {
					// ├ replaces │; the header's `─ ` occupies the left padding slot, so content width = innerWidth + pad.
					const junction = (child as Partial<Flushable>).junctionPaint ?? frame;
					lines.push(`${junction("├")}${fitExactly(line, innerWidth + pad.length)}${pad}${side}`);
					return;
				}
				if (flush) {
					// Continuation rows align with the ├─ header text column (the row's own 2-column indent lands on col 3).
					lines.push(`${side}${fitExactly(line, innerWidth + pad.length)}${pad}${side}`);
					return;
				}
				lines.push(`${side}${pad}${fitExactly(line, innerWidth)}${pad}${side}`);
			});
			hasContent = true;
			emitFoldLine();
		}
		emitFoldLine();
		lines.push(blankInner, bottom);
		return lines;
	}
}

const HISTORY_MAX = 6;
export class SectionCaption implements Component {
	private mode: "live" | "summary" = "live";
	// Sealed once the summary settles: late events (race/retry tail) must not revert it to live.
	private sealed = false;
	private spinnerFrame = 0;
	private readonly history: string[] = [];
	private overflow = 0;
	private liveText = "";
	private summaryText: string;
	// History rows are immutable once pushed; only pushDone bumps historyVersion to invalidate the cache.
	private readonly historyCache = new WidthCache();
	private historyVersion = 0;
	onRedraw?: () => void;

	constructor(
		text: string,
		private readonly styles: ThemeStyles,
	) {
		this.summaryText = text;
	}

	setLive(text: string): void {
		if (this.sealed) return;
		this.mode = "live";
		this.liveText = text;
	}

	pushDone(text: string): void {
		if (this.sealed) return;
		this.mode = "live";
		this.history.push(text);
		if (this.history.length > HISTORY_MAX) {
			this.history.shift();
			this.overflow += 1;
		}
		this.historyVersion += 1;
	}

	setSummary(text: string): void {
		this.sealed = true;
		this.mode = "summary";
		this.summaryText = text;
		this.liveText = "";
	}

	tick(): void {
		if (this.mode !== "live") return;
		this.spinnerFrame += 1;
		this.onRedraw?.();
	}

	invalidate(): void {
		this.historyCache.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(width, MIN_WRAP_WIDTH);
		if (this.mode === "summary") {
			// Empty summary = card-separating breathing line.
			if (this.summaryText === "") return [""];
			return ["", ...wrapTextWithAnsi(this.styles.dim(`  ${this.summaryText}`), safeWidth), ""];
		}
		if (this.overflow === 0 && this.history.length === 0 && this.liveText === "") return [];
		const out: string[] = [""];
		out.push(
			...this.historyCache.render(safeWidth, [this.historyVersion], (w) => {
				const block: string[] = [];
				if (this.overflow > 0) block.push(...wrapTextWithAnsi(this.styles.faint(`  …${this.overflow} more`), w));
				for (const line of this.history)
					block.push(...wrapTextWithAnsi(this.styles.dim(`  ${BRANCH_BULLET}${line}`), w));
				return block;
			}),
		);
		if (this.liveText !== "") {
			const spinner = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
			out.push(...wrapTextWithAnsi(this.styles.accent(`  ${spinner} ${this.liveText}`), safeWidth));
		}
		out.push("");
		return out;
	}
}

export interface SectionToolPart {
	toolName: string;
	durationMs: number;
	isError: boolean;
	preview: string;
}
