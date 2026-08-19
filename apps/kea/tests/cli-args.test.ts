import { describe, expect, test } from "vitest";

const CLI_PATH = new URL("../src/cli.ts", import.meta.url).pathname;

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn({ cmd: ["bun", CLI_PATH, ...args], stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, stdout, stderr };
}

describe("cli argument parsing (exit code semantics)", () => {
	test("unknown argument → exit code 1 (a mistyped CI flag must not silently succeed)", async () => {
		const { code, stdout, stderr } = await runCli(["--definitely-not-a-flag"]);
		expect(code).toBe(1);
		expect(stderr).toContain("Unknown argument: --definitely-not-a-flag");
		expect(stdout).toContain("Usage:");
	}, 30_000);

	test("--help → exit code 0", async () => {
		const { code, stdout } = await runCli(["--help"]);
		expect(code).toBe(0);
		expect(stdout).toContain("Usage:");
	}, 30_000);

	test("-p followed by another flag → errors out, must not swallow the following flag (regression)", async () => {
		const { code, stderr } = await runCli(["run", "-p", "--format", "ndjson"]);
		expect(code).toBe(1);
		expect(stderr).toContain("-p requires a value");
	}, 30_000);

	test("-p / -m missing value (end of line) → error exit + usage hint", async () => {
		for (const args of [
			["run", "-p"],
			["run", "-m"],
		] as string[][]) {
			const { code, stderr } = await runCli(args);
			expect(code, args.join(" ")).toBe(1);
			expect(stderr, args.join(" ")).toContain("requires a value");
			expect(stderr, args.join(" ")).toContain("--help");
		}
	}, 30_000);

	test("--max-rounds / --max-minutes must be positive integers", async () => {
		for (const args of [
			["mobai", "--max-rounds", "2.5"],
			["mobai", "--max-rounds", "abc"],
			["mobai", "--max-minutes", "0"],
			["mobai", "--max-minutes"],
		] as string[][]) {
			const { code, stderr } = await runCli(args);
			expect(code, args.join(" ")).toBe(1);
			expect(stderr, args.join(" ")).toMatch(/positive integer|requires a value/);
		}
	}, 30_000);
});
