import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { makeTempDir, removeTempDir } from "../helpers/temp-dir.ts";
import { KEA_CLI_PATH, spawnKeaPty } from "./pty-helper.ts";

// Agent e2e (real LLM, gated by ANTHROPIC_API_KEY):
// yolo: bash commands run directly; manual: sudo commands surface an approval panel; Esc rejects.

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const dirs: string[] = [];

afterAll(async () => {
	for (const d of dirs) await removeTempDir(d).catch(() => {});
});

async function makeEnv(): Promise<{ home: string; ws: string }> {
	const home = await makeTempDir("kea-e2e-ag-home-");
	const ws = await makeTempDir("kea-e2e-ag-ws-");
	dirs.push(home, ws);
	return { home, ws };
}

describe.skipIf(!HAS_KEY)("Agent e2e (real LLM)", () => {
	test("yolo: bash commands run without approval", async () => {
		const { home, ws } = await makeEnv();
		const marker = join(ws, "yolo-marker.txt");
		const pty = spawnKeaPty({
			cwd: ws,
			cliPath: KEA_CLI_PATH,
			args: ["--permission", "yolo"],
			env: { KEA_HOME: home },
		});
		try {
			expect(await pty.waitForText("Trust this folder?", 45_000)).toBe(true);
			pty.write("\r");
			expect(await pty.waitForText("context:", 60_000)).toBe(true);
			pty.write(`Run exactly one bash command: touch ${marker}. Do nothing else.\r`);
			expect(await pty.waitForText("Ran a command", 120_000)).toBe(true);
			const markerMade = await Bun.file(marker).exists();
			expect(markerMade).toBe(true);
		} finally {
			pty.kill();
		}
	}, 240_000);

	test("manual: sudo surfaces approval panel with danger tag; Esc rejects", async () => {
		const { home, ws } = await makeEnv();
		const pty = spawnKeaPty({
			cwd: ws,
			cliPath: KEA_CLI_PATH,
			args: ["--permission", "manual"],
			env: { KEA_HOME: home },
		});
		try {
			expect(await pty.waitForText("Trust this folder?", 45_000)).toBe(true);
			pty.write("\r");
			expect(await pty.waitForText("context:", 60_000)).toBe(true);
			pty.write("Run exactly one bash command: sudo echo hi. Do nothing else.\r");
			expect(await pty.waitForText("Run this command?", 120_000)).toBe(true);
			expect(pty.text()).toContain("Privilege escalation");
			pty.write("\x1b");
			await Bun.sleep(1_000);
		} finally {
			pty.kill();
		}
	}, 240_000);
});
