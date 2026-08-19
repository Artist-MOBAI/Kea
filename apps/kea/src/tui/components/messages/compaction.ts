import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "../../constants/format.ts";
import { BRANCH_BULLET, FAILURE_MARK, SPINNER_FRAMES } from "../../constants/symbols.ts";
import type { ThemeStyles } from "../../theme.ts";
import { WidthCache } from "./render-cache.ts";
import { MESSAGE_INDENT } from "./text-util.ts";

const SPINNER_INTERVAL_MS = 100;

/** Live spinner frame index: dep and rendering share the same derivation, so dep advances exactly on frame switch. */
function spinnerFrame(): number {
	return Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
}

export class CompactionView implements Component {
	private mode: "live" | "done" | "failed" = "live";
	private tokensBefore?: number;
	private tokensAfter?: number;
	private failReason?: string;
	private readonly cache = new WidthCache();

	constructor(readonly styles: ThemeStyles) {}

	invalidate(): void {
		this.cache.invalidate();
	}

	finish(tokensBefore?: number, tokensAfter?: number): void {
		this.mode = "done";
		this.tokensBefore = tokensBefore;
		this.tokensAfter = tokensAfter;
		this.cache.invalidate();
	}

	fail(reason?: string): void {
		this.mode = "failed";
		this.failReason = reason;
		this.cache.invalidate();
	}

	render(width: number): string[] {
		// The live spinner frame advances with time, so the frame index goes into dep — with dep [],
		// fixed-width rendering always hits the first-frame cache and freezes the animation.
		const frame = this.mode === "live" ? spinnerFrame() : 0;
		return this.cache.render(width, [this.mode, frame], (w) => {
			const { styles } = this;
			let lines: string[];
			if (this.mode === "live") {
				const glyph = SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0];
				lines = [`${styles.dim(glyph)} ${styles.dim("compacting context…")}`];
			} else if (this.mode === "failed") {
				const reason = this.failReason !== undefined && this.failReason !== "" ? ` · ${this.failReason}` : "";
				lines = [`${styles.error(`${FAILURE_MARK} `)}${styles.error(`compaction failed${reason}`)}`];
			} else {
				const counts =
					this.tokensBefore !== undefined && this.tokensAfter !== undefined
						? ` (${formatTokens(this.tokensBefore)} → ${formatTokens(this.tokensAfter)} tokens)`
						: "";
				lines = [
					`${styles.success(BRANCH_BULLET)}${styles.dim(`context compacted${counts} · research ledger intact`)}`,
				];
			}
			return lines.map((line) => truncateToWidth(MESSAGE_INDENT + line, w, "…"));
		});
	}
}
