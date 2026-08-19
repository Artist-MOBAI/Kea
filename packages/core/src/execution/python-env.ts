import { join } from "node:path";

export interface PythonEnv {
	path: string;
	python: string;
	created: boolean;
}

export function envKey(name: string, requirements: string[]): string {
	const digest = new Bun.CryptoHasher("sha256")
		.update(JSON.stringify([...requirements].sort()))
		.digest("hex")
		.slice(0, 16);
	const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	return `${safe}-${digest}`;
}

export function envsDir(cwd: string): string {
	return join(cwd, ".kea", "envs");
}

/** Run a child under a kill timer, draining stderr concurrently (reading only after exit deadlocks once the pipe fills); throws with the stderr tail on non-zero exit. */
async function runDrained(
	proc: { exited: Promise<number>; kill(): void; stderr: ReadableStream<Uint8Array> },
	timeoutMs: number,
	fail: (stderrTail: string) => Error,
): Promise<void> {
	const timer = setTimeout(() => proc.kill(), timeoutMs);
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	clearTimeout(timer);
	if (exitCode !== 0) throw fail(stderr.slice(-500));
}

export async function ensurePythonEnv(args: {
	cwd: string;
	name: string;
	requirements?: string[];
	pythonBinary?: string;
	venvTimeoutMs?: number;
	pipTimeoutMs?: number;
}): Promise<PythonEnv> {
	const requirements = args.requirements ?? [];
	const key = envKey(args.name, requirements);
	const dir = join(envsDir(args.cwd), key);
	const marker = join(dir, ".kea-ready");
	const python = process.platform === "win32" ? join(dir, "Scripts", "python.exe") : join(dir, "bin", "python");

	const markerFile = Bun.file(marker);
	if ((await markerFile.exists()) && (await markerFile.text()) === key) {
		return { path: dir, python, created: false };
	}

	const py = args.pythonBinary ?? process.env.KEA_PYTHON ?? "python3";
	const mk = Bun.spawn([py, "-m", "venv", dir], { stdout: "ignore", stderr: "pipe" });
	await runDrained(mk, args.venvTimeoutMs ?? 120_000, (tail) =>
		Error(`venv creation failed for ${key} (is ${py} available?): ${tail}`),
	);

	if (requirements.length > 0) {
		const reqFile = join(dir, "requirements.txt");
		await Bun.write(reqFile, requirements.join("\n"));
		const pip = Bun.spawn([python, "-m", "pip", "install", "-r", reqFile], { stdout: "ignore", stderr: "pipe" });
		await runDrained(pip, args.pipTimeoutMs ?? 30 * 60_000, (tail) => Error(`pip install failed for ${key}: ${tail}`));
	}

	await Bun.write(marker, key);
	return { path: dir, python, created: true };
}
