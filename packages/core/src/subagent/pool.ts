export async function mapPooled<T, R>(
	items: readonly T[],
	maxConcurrency: number,
	fn: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(maxConcurrency, items.length)) }, async () => {
		while (next < items.length) {
			signal?.throwIfAborted();
			const index = next++;
			const item = items[index];
			if (item === undefined) break;
			results[index] = await fn(item, index);
		}
	});
	await Promise.all(workers);
	return results;
}
