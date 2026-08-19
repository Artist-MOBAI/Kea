export type DiffLineKind = "context" | "add" | "delete";

export interface DiffLine {
	kind: DiffLineKind;
	code: string;
}

export interface ClusteredLine {
	kind: "header" | DiffLineKind | "gap";
	text: string;
}

// LCS DP cap: beyond it, degrade to a full -/+ diff (prevents large-file approval from freezing render).
const LCS_CELL_CAP = 250_000;

export function computeDiffLines(oldText: string, newText: string): DiffLine[] | undefined {
	const oldLines = oldText === "" ? [] : oldText.split("\n");
	const newLines = newText === "" ? [] : newText.split("\n");
	const m = oldLines.length;
	const n = newLines.length;
	if (m * n > LCS_CELL_CAP) return undefined;

	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const row = dp[i] ?? [];
			const prev = dp[i - 1] ?? [];
			row[j] = oldLines[i - 1] === newLines[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, row[j - 1] ?? 0);
		}
	}

	const reversed: DiffLine[] = [];
	let i = m;
	let j = n;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			reversed.push({ kind: "context", code: newLines[j - 1] ?? "" });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || (dp[i]?.[j - 1] ?? 0) >= (dp[i - 1]?.[j] ?? 0))) {
			reversed.push({ kind: "add", code: newLines[j - 1] ?? "" });
			j--;
		} else {
			reversed.push({ kind: "delete", code: oldLines[i - 1] ?? "" });
			i--;
		}
	}
	reversed.reverse();
	return reversed;
}

// Oversized diffs (LCS cap) return undefined; callers degrade to a full -/+ diff.
export function clusterDiffPreview(
	oldText: string,
	newText: string,
	path: string,
	contextLines = 3,
): ClusteredLine[] | undefined {
	const lines = computeDiffLines(oldText, newText);
	if (lines === undefined) return undefined;

	const added = lines.filter((l) => l.kind === "add").length;
	const removed = lines.filter((l) => l.kind === "delete").length;
	const headerParts: string[] = [];
	if (added > 0) headerParts.push(`+${added}`);
	if (removed > 0) headerParts.push(`-${removed}`);
	const out: ClusteredLine[] = [{ kind: "header", text: `${headerParts.join(" ")} ${path}`.trimStart() }];
	if (added === 0 && removed === 0) return out;

	// Changed rows cluster with ±context neighbors (merging overlapping intervals)
	const changed = new Set<number>();
	lines.forEach((l, idx) => {
		if (l.kind !== "context") changed.add(idx);
	});
	const clusters: Array<{ start: number; end: number }> = [];
	for (const idx of changed) {
		const start = Math.max(0, idx - contextLines);
		const end = Math.min(lines.length - 1, idx + contextLines);
		const last = clusters[clusters.length - 1];
		if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
		else clusters.push({ start, end });
	}

	let prevEnd = -1;
	for (const cluster of clusters) {
		if (prevEnd >= 0) {
			const gap = cluster.start - prevEnd - 1;
			if (gap > 0) out.push({ kind: "gap", text: `… ${gap} unchanged lines …` });
		}
		for (const line of lines.slice(cluster.start, cluster.end + 1)) {
			out.push({ kind: line.kind, text: line.code });
		}
		prevEnd = cluster.end;
	}
	return out;
}
