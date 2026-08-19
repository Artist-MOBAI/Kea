import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createReadMediaFileTool } from "../src/tools-media.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

async function setup(): Promise<string> {
	workdir = await mkdtemp(join(tmpdir(), "kea-media-"));
	await writeFile(join(workdir, "img.png"), TINY_PNG);
	await writeFile(join(workdir, "notes.txt"), "hello");
	return workdir;
}

describe("read_media_file", () => {
	test("reading a png returns an image part (base64 + mimeType) plus caption text", async () => {
		const cwd = await setup();
		const tool = createReadMediaFileTool({ cwd, supportsImages: () => true });
		const result = await tool.execute("id", { path: "img.png" });
		const image = result.content.find((c) => c.type === "image") as { data: string; mimeType: string } | undefined;
		expect(image?.mimeType).toBe("image/png");
		expect(image?.data).toBe(TINY_PNG.toString("base64"));
		expect(result.content.some((c) => c.type === "text")).toBe(true);
	});

	test("model without image support: explicit placeholder text, not silently dropped", async () => {
		const cwd = await setup();
		const tool = createReadMediaFileTool({ cwd, supportsImages: () => false });
		const result = await tool.execute("id", { path: "img.png" });
		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain("image omitted");
		expect(result.details).toMatchObject({ omitted: true });
	});

	test("unsupported format throws", async () => {
		const cwd = await setup();
		const tool = createReadMediaFileTool({ cwd, supportsImages: () => true });
		await expect(tool.execute("id", { path: "notes.txt" })).rejects.toThrow(/Unsupported media type/);
	});

	test("missing file throws", async () => {
		const cwd = await setup();
		const tool = createReadMediaFileTool({ cwd, supportsImages: () => true });
		await expect(tool.execute("id", { path: "missing.png" })).rejects.toThrow(/not found/);
	});

	test("sensitive file refused (throw)", async () => {
		const cwd = await setup();
		await writeFile(join(cwd, ".env.png"), "x"); // craft a sensitive name (.env prefix)
		const tool = createReadMediaFileTool({ cwd, supportsImages: () => true });
		await expect(tool.execute("id", { path: ".env.png" })).rejects.toThrow(/sensitive/);
	});

	test("symlink to a sensitive file refused (realpath recheck, bypass regression)", async () => {
		const cwd = await setup();
		await writeFile(join(cwd, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----");
		await symlink(join(cwd, "id_rsa"), join(cwd, "photo.png"));
		const tool = createReadMediaFileTool({ cwd, supportsImages: () => true });
		await expect(tool.execute("id", { path: "photo.png" })).rejects.toThrow(/sensitive/);
	});

	test("symlink to an ordinary image reads normally (no false positive)", async () => {
		const cwd = await setup();
		await symlink(join(cwd, "img.png"), join(cwd, "alias.png"));
		const tool = createReadMediaFileTool({ cwd, supportsImages: () => true });
		const result = await tool.execute("id", { path: "alias.png" });
		const image = result.content.find((c) => c.type === "image") as { data: string; mimeType: string } | undefined;
		expect(image?.mimeType).toBe("image/png");
		expect(image?.data).toBe(TINY_PNG.toString("base64"));
	});

	test("supportsImages evaluated lazily (takes effect immediately on model switch)", async () => {
		const cwd = await setup();
		let supported = false;
		const tool = createReadMediaFileTool({ cwd, supportsImages: () => supported });
		const before = await tool.execute("id", { path: "img.png" });
		expect(before.details).toMatchObject({ omitted: true });
		supported = true;
		const after = await tool.execute("id", { path: "img.png" });
		expect(after.content.some((c) => c.type === "image")).toBe(true);
	});
});
