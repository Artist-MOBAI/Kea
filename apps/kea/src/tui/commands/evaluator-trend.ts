const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** Unicode block sparkline; a single value renders the centered block, constant series render the middle block. */
export function sparkline(values: readonly number[]): string {
	if (values.length === 0) return "";
	if (values.length === 1) return BLOCKS[4];
	const min = Math.min(...values);
	const max = Math.max(...values);
	const span = max - min;
	return values.map((v) => BLOCKS[span === 0 ? 4 : Math.round(((v - min) / span) * 7)]).join("");
}
