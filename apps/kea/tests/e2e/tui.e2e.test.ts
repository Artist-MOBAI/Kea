import { afterAll, describe, expect, test } from "vitest";
import { makeTempDir, removeTempDir } from "../helpers/temp-dir.ts";
import { KEA_CLI_PATH, spawnKeaPty } from "./pty-helper.ts";

// TUI e2e (no LLM): trust prompt → welcome screen → /help → exit.

const dirs: string[] = [];

afterAll(async () => {
	for (const d of dirs) await removeTempDir(d).catch(() => {});
});

async function makeEnv(): Promise<{ home: string; ws: string }> {
	const home = await makeTempDir("kea-e2e-home-");
	const ws = await makeTempDir("kea-e2e-ws-");
	dirs.push(home, ws);
	return { home, ws };
}

describe("TUI e2e (no LLM)", () => {
	test("trust prompt → trust → welcome screen and footer render", async () => {
		const { home, ws } = await makeEnv();
		const pty = spawnKeaPty({ cwd: ws, cliPath: KEA_CLI_PATH, env: { KEA_HOME: home } });
		try {
			expect(await pty.waitForText("Trust this folder?", 45_000)).toBe(true);
			expect(pty.text()).toContain("Don't trust");
			pty.write("\r");
			expect(await pty.waitForText("context:", 60_000)).toBe(true);
			expect(pty.text()).toContain("Welcome to Kea!");
			expect(pty.text()).toContain("/help for commands");
		} finally {
			pty.kill();
		}
	}, 120_000);

	test("/help panel lists commands and can be closed", async () => {
		const { home, ws } = await makeEnv();
		const pty = spawnKeaPty({ cwd: ws, cliPath: KEA_CLI_PATH, env: { KEA_HOME: home } });
		try {
			expect(await pty.waitForText("Trust this folder?", 45_000)).toBe(true);
			pty.write("\r");
			expect(await pty.waitForText("context:", 60_000)).toBe(true);
			pty.write("/help\r");
			expect(await pty.waitForText("all commands", 20_000)).toBe(true);
			expect(pty.text()).toContain("/model");
			expect(pty.text()).toContain("/yolo");
			pty.write("\x1b");
			await Bun.sleep(500);
		} finally {
			pty.kill();
		}
	}, 120_000);
});
