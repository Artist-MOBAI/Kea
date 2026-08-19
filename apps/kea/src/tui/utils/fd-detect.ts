const CANDIDATES = ["fd", "fdfind"];

export function detectFdPath(): string | null {
	for (const name of CANDIDATES) {
		const path = Bun.which(name);
		if (!path) continue;
		const proc = Bun.spawnSync([path, "--version"], { stdout: "ignore", stderr: "ignore" });
		if (proc.exitCode === 0) return path;
	}
	return null;
}
