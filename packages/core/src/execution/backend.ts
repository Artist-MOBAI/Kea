import { readMeta } from "./ledger.ts";
import type { ExecutionBackend } from "./types.ts";

export class BackendRegistry {
	private readonly backends = new Map<string, ExecutionBackend>();

	constructor(private readonly cwd: string) {}

	register(backend: ExecutionBackend): void {
		this.backends.set(backend.name, backend);
	}

	get(name: string): ExecutionBackend | undefined {
		return this.backends.get(name);
	}

	names(): string[] {
		return [...this.backends.keys()];
	}

	/** Settle all backends' orphan jobs at startup (best-effort: an unreachable remote backend only skips itself). */
	async reclaimAll(): Promise<number> {
		let total = 0;
		for (const backend of this.backends.values()) {
			try {
				total += await backend.reclaimOrphans();
			} catch {
				// unreachable remote backend: reclaim is best-effort and must not block startup
			}
		}
		return total;
	}

	async backendOfJob(jobId: string): Promise<ExecutionBackend | undefined> {
		const meta = await readMeta(this.cwd, jobId);
		if (!meta) return undefined;
		return this.backends.get(meta.backend);
	}
}
