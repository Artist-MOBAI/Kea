import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspaceTrustInfo, isFolderTrusted, trustFolder, trustStorePath } from "@kea/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { makeTempDir, removeTempDir } from "./helpers/temp-dir.ts";

// Isolate the trust store with a temp HOME to avoid polluting the real ~/.kea (vitest forks a separate process per file)
let fakeHome: string;
let workDir: string;
let realHome: string | undefined;

beforeAll(async () => {
	realHome = process.env.KEA_HOME;
	fakeHome = await makeTempDir("kea-trust-home-");
	workDir = await makeTempDir("kea-trust-ws-");
	process.env.KEA_HOME = fakeHome;
});

afterAll(async () => {
	if (realHome !== undefined) process.env.KEA_HOME = realHome;
	else delete process.env.KEA_HOME;
	await removeTempDir(fakeHome);
	await removeTempDir(workDir);
});

describe("workspace trust (kimi paradigm: stored in home, fail-closed, gates project MCP)", () => {
	test("untrusted by default; trusted after trustFolder", async () => {
		expect(await isFolderTrusted(workDir)).toBe(false);
		await trustFolder(workDir);
		expect(await isFolderTrusted(workDir)).toBe(true);
	});

	test("stored in home, never in the workspace (prevents repo self-trusting)", async () => {
		expect(trustStorePath().startsWith(`${fakeHome}/`)).toBe(true);
		const inWorkspace = Bun.file(join(workDir, ".kea", "trusted-folders.json"));
		expect(await inWorkspace.exists()).toBe(false);
	});

	test("repeated trust dedupes (one record per directory)", async () => {
		await trustFolder(workDir);
		const parsed = (await Bun.file(trustStorePath()).json()) as { folders: Record<string, unknown> };
		expect(Object.keys(parsed.folders).length).toBe(1);
	});

	test("corrupted trust file counts as untrusted (fail-closed)", async () => {
		await writeFile(trustStorePath(), "{ broken json");
		expect(await isFolderTrusted(workDir)).toBe(false);
		await trustFolder(workDir);
	});

	test("getWorkspaceTrustInfo returns the project MCP list that would be allowed", async () => {
		const mcpDir = join(workDir, ".kea");
		await writeFile(join(mcpDir, "mcp.json"), JSON.stringify({ mcpServers: { mp: { command: "mp-server" } } })).catch(
			async () => {
				const { mkdir } = await import("node:fs/promises");
				await mkdir(mcpDir, { recursive: true });
				await writeFile(join(mcpDir, "mcp.json"), JSON.stringify({ mcpServers: { mp: { command: "mp-server" } } }));
			},
		);
		const trusted = await getWorkspaceTrustInfo(workDir);
		expect(trusted.trusted).toBe(true);
		expect(trusted.gatedMcpServers).toEqual([]);
	});
});

describe("MCP gating (the only real effect of trust)", () => {
	test("loadMcpConfig fail-closed: only explicit includeProject:true loads project config", async () => {
		const { loadMcpConfig } = await import("@kea/core");
		// core defaults to fail-closed: both absent and explicit false skip loading; trust state is passed in by the caller (kernel/doctor)
		expect(await loadMcpConfig(workDir)).toEqual({});
		const gated = await loadMcpConfig(workDir, { includeProject: false });
		expect(gated).toEqual({});
		const full = await loadMcpConfig(workDir, { includeProject: true });
		expect(Object.keys(full.mcpServers ?? {})).toContain("mp");
	});
});

describe("untrustFolder (kimi untrust equivalent)", () => {
	test("trusted → untrust → untrusted", async () => {
		const { untrustFolder } = await import("@kea/core");
		await trustFolder(workDir);
		expect(await isFolderTrusted(workDir)).toBe(true);
		await untrustFolder(workDir);
		expect(await isFolderTrusted(workDir)).toBe(false);
	});
});
