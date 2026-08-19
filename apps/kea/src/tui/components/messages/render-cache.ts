// Width-keyed render cache: TuiMainScreen line-diffs only at the terminal layer while the JS side
// renders the whole tree every frame — a component-level cache is the sanctioned optimization path.

export const MIN_WRAP_WIDTH = 8;

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export class WidthCache {
	private cachedWidth: number | undefined;
	private cachedDeps: readonly unknown[] | undefined;
	private cachedLines: string[] | undefined;

	/** Hits when width is equal and deps match item-by-item via ===; otherwise recompute and record. deps can be a literal array (shallow compare). */
	render(width: number, deps: readonly unknown[], compute: (width: number) => string[]): string[] {
		if (
			this.cachedLines !== undefined &&
			this.cachedWidth === width &&
			this.cachedDeps !== undefined &&
			sameDeps(this.cachedDeps, deps)
		) {
			return this.cachedLines;
		}
		this.cachedLines = compute(width);
		this.cachedWidth = width;
		this.cachedDeps = deps;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
		this.cachedDeps = undefined;
	}
}
