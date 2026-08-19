import { join } from "node:path";
import type { Kernel } from "@kea/core";
import { afterAll, describe, expect, test } from "vitest";
import { loadConfig, saveConfig } from "../src/config.ts";
import { dispatchInput } from "../src/tui/commands/dispatch.ts";
import type { SlashCommandHost } from "../src/tui/commands/types.ts";
import { makeTempDir, removeTempDir } from "./helpers/temp-dir.ts";

let dir: string;

afterAll(async () => {
	if (dir) await removeTempDir(dir);
});

describe("flat toml config (M1)", () => {
	test("round-trips strings/numbers/booleans and merges on save", async () => {
		dir = await makeTempDir("kea2-cfg-");
		const path = join(dir, "kea.toml");
		await saveConfig(path, { defaultModel: "anthropic/claude-sonnet-4-5", maxTurns: 12, autoApprove: false });
		await saveConfig(path, { contextWindow: 200000 });

		const cfg = await loadConfig(path);
		expect(cfg.defaultModel).toBe("anthropic/claude-sonnet-4-5");
		expect(cfg.maxTurns).toBe(12);
		expect(cfg.autoApprove).toBe(false);
		expect(cfg.contextWindow).toBe(200000);
	});

	test("missing file loads as empty; malformed lines skipped", async () => {
		dir = await makeTempDir("kea2-cfg-");
		const path = join(dir, "missing.toml");
		expect(await loadConfig(path)).toEqual({});

		await Bun.write(path, '# comment\nbroken line\nkey = "value"\n[future-section]\n');
		const cfg = await loadConfig(path);
		expect(cfg.key).toBe("value");
		expect(cfg["broken line"]).toBeUndefined();
	});

	test("values with quotes/backslashes round-trip intact (parse and JSON.stringify stay symmetric)", async () => {
		dir = await makeTempDir("kea2-cfg-");
		const path = join(dir, "escape.toml");
		const tricky = 'say "hi" \\ done\ttabbed';
		await saveConfig(path, { note: tricky, url: "https://example.com/?a=1&b=2" });
		const cfg = await loadConfig(path);
		expect(cfg.note).toBe(tricky);
		expect(cfg.url).toBe("https://example.com/?a=1&b=2");
	});

	test("trailing # comments outside quotes are not folded into the value", async () => {
		dir = await makeTempDir("kea2-cfg-");
		const path = join(dir, "comments.toml");
		await Bun.write(path, 'model = "p/m" # my model\ncount = 5 # five\nflag = true # on\n');
		const cfg = await loadConfig(path);
		expect(cfg.model).toBe("p/m");
		expect(cfg.count).toBe(5);
		expect(cfg.flag).toBe(true);
	});

	test("corrupted file (non key=value line): saveConfig rejects, original bytes kept (no silent wipe)", async () => {
		dir = await makeTempDir("kea2-cfg-");
		const path = join(dir, "corrupt.toml");
		const bytes = '# my config\nbroken line without equals\nmodel = "p/m"\n';
		await Bun.write(path, bytes);
		await expect(saveConfig(path, { count: 5 })).rejects.toThrow(/corrupted.*broken line/s);
		// the corrupted file must be left untouched for manual repair
		expect(new TextDecoder().decode(await Bun.file(path).arrayBuffer())).toBe(bytes);
	});

	test("corrupted file (unclosed quote): saveConfig rejects", async () => {
		dir = await makeTempDir("kea2-cfg-");
		const path = join(dir, "quote.toml");
		await Bun.write(path, 'model = "unclosed\n');
		await expect(saveConfig(path, { count: 5 })).rejects.toThrow(/unclosed quote/);
	});

	test("atomic write: no tmp residue after save, content intact", async () => {
		dir = await makeTempDir("kea2-cfg-");
		const path = join(dir, "atomic.toml");
		await saveConfig(path, { defaultModel: "p/m", maxTurns: 3 });
		await saveConfig(path, { extra: true });
		const entries = Array.from(new Bun.Glob("*").scanSync(dir));
		expect(entries).toEqual(["atomic.toml"]);
		const cfg = await loadConfig(path);
		expect(cfg.defaultModel).toBe("p/m");
		expect(cfg.maxTurns).toBe(3);
		expect(cfg.extra).toBe(true);
	});
});

describe("structured TOML guard (G10: flat writer must not silently wipe tables/arrays)", () => {
	test("with a [section] header: saveConfig refuses to rewrite and keeps original bytes", async () => {
		dir = await makeTempDir("kea2-cfg-");
		const path = join(dir, "structured.toml");
		const bytes = 'default_model = "p/m"\n[permission]\nallow = ["Bash(git status)"]\n';
		await Bun.write(path, bytes);
		await expect(saveConfig(path, { count: 5 })).rejects.toThrow(/table header.*\[permission\]/s);
		expect(new TextDecoder().decode(await Bun.file(path).arrayBuffer())).toBe(bytes);
	});

	test("with an array value: saveConfig refuses to rewrite and keeps original bytes", async () => {
		dir = await makeTempDir("kea2-cfg-");
		const path = join(dir, "array.toml");
		const bytes = 'allow = ["bash", "read"]\n';
		await Bun.write(path, bytes);
		await expect(saveConfig(path, { count: 5 })).rejects.toThrow(/array value/);
		expect(new TextDecoder().decode(await Bun.file(path).arrayBuffer())).toBe(bytes);
	});

	test("/model set is refused with a [permission] section (error names the file and manual editing)", async () => {
		dir = await makeTempDir("kea2-cfg-");
		const configPath = join(dir, ".kea", "kea.toml");
		const bytes = '[permission]\nallow = ["Bash(git status)"]\n';
		await Bun.write(configPath, bytes);
		const errors: string[] = [];
		const host = {
			cwd: dir,
			isStreaming: () => false,
			isCompacting: () => false,
			showStatus: () => {},
			showError: (t: string) => errors.push(t),
			showNotice: () => {},
		} as unknown as SlashCommandHost;
		const kernel = { setModel: () => ({ provider: "p", id: "m" }) } as unknown as Kernel;

		await dispatchInput(host, kernel, "/model p/m");

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("[permission]");
		expect(errors[0]).toContain("manually");
		expect(errors[0]).toContain(configPath);
		expect(new TextDecoder().decode(await Bun.file(configPath).arrayBuffer())).toBe(bytes);
	});
});
