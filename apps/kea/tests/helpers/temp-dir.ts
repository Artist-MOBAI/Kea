import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create a prefixed, isolated directory under the system temp dir; callers clean it up in afterAll via removeTempDir. */
export function makeTempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

export function removeTempDir(dir: string): Promise<void> {
	return rm(dir, { recursive: true, force: true });
}
