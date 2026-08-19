import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

// Width-safe decorator: wraps any component and truncates each rendered row to the width. pi-tui
// throws on over-width rows and crashes the whole TUI, so this is a global defense. The memo is
// keyed by (width, input array reference): inner components carry their own WidthCache and return
// the same reference on unchanged frames, skipping the per-row truncate path.
export class WidthSafe implements Component {
	private memo: { width: number; input: string[]; output: string[] } | undefined;

	constructor(private readonly inner: Component) {}

	get wrapped(): Component {
		return this.inner;
	}

	invalidate(): void {
		this.memo = undefined;
		this.inner.invalidate?.();
	}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		const memo = this.memo;
		if (memo !== undefined && memo.width === width && memo.input === lines) return memo.output;
		const output = lines.map((line) => truncateToWidth(line, width));
		this.memo = { width, input: lines, output };
		return output;
	}

	handleInput(data: string): void {
		this.inner.handleInput?.(data);
	}
}
