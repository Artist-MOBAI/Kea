const DEFAULT_TIMEOUT_MS = 30_000;

export interface FetchOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export function reasonOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// The raw Response is returned with no status judgement — sites that need status-specific handling (404/401) branch at this layer.
export async function fetchWithDeadline(
	url: string,
	init?: RequestInit,
	options: FetchOptions = {},
): Promise<Response> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const deadline = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
	return fetchImpl(url, { ...init, signal });
}

// The parsed body is not structurally validated — callers safeParse it themselves, failing closed per their own semantics.
export async function fetchJson<T = unknown>(
	url: string,
	init: RequestInit | undefined,
	label: string,
	options: FetchOptions = {},
): Promise<T> {
	const response = await fetchWithDeadline(url, init, options);
	if (!response.ok) throw new Error(`${label} ${response.status}`);
	return (await response.json()) as T;
}
