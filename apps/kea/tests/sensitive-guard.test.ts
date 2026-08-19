import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBaseTools, createExecutionEnv } from "@kea/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { makeTempDir, removeTempDir } from "./helpers/temp-dir.ts";

let dir: string;
let tools: ReturnType<typeof createBaseTools>;

beforeAll(async () => {
	dir = await makeTempDir("kea-sensitive-");
	await writeFile(join(dir, ".env"), "SECRET=1");
	await writeFile(join(dir, ".env.example"), "SECRET=changeme");
	await writeFile(join(dir, "normal.txt"), "hello\nworld\n");
	const { env } = await createExecutionEnv(dir);
	tools = createBaseTools(env);
});

afterAll(async () => {
	await removeTempDir(dir);
});

const textOf = (res: { content: Array<{ type: string; text?: string }> }) =>
	res.content
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");

describe("sensitive-file guard (kimi alignment)", () => {
	test("read refuses .env, allows .env.example and normal files", async () => {
		const read = tools.find((t) => t.name === "read");
		expect(read).toBeDefined();
		await expect(read?.execute("t1", { path: join(dir, ".env") }, undefined, undefined as never)).rejects.toThrow(
			"refused",
		);
		const example = await read?.execute("t2", { path: join(dir, ".env.example") }, undefined, undefined as never);
		expect(textOf(example as never)).toContain("changeme");
	});

	test("write/edit refuse sensitive paths", async () => {
		const write = tools.find((t) => t.name === "write");
		await expect(
			write?.execute("t3", { path: join(dir, ".env"), content: "X=1" }, undefined, undefined as never),
		).rejects.toThrow("refused");
		const edit = tools.find((t) => t.name === "edit");
		await expect(
			edit?.execute(
				"t4",
				{ path: join(dir, ".env"), edits: [{ oldText: "SECRET=1", newText: "SECRET=2" }] },
				undefined,
				undefined as never,
			),
		).rejects.toThrow("refused");
	});

	test("glob filters sensitive files", async () => {
		const glob = tools.find((t) => t.name === "glob");
		const res = await glob?.execute("t5", { pattern: "*", path: dir }, undefined, undefined as never);
		const body = textOf(res as never);
		expect(body).toContain("normal.txt");
		// the REAL secret file is filtered; exempt templates (kimi/--hidden parity) may be listed —
		// listing is not reading, read keeps refusing .env while .env.example stays readable
		expect(body).not.toMatch(/(^|\n)\.env(\n|$)/);
		expect(body).toContain(".env.example");
	});

	test("grep filters result lines from sensitive files", async () => {
		const grep = tools.find((t) => t.name === "grep");
		const res = await grep?.execute("t6", { pattern: "SECRET|hello", path: dir }, undefined, undefined as never);
		const body = textOf(res as never);
		expect(body).toContain("hello");
		expect(body).not.toContain("SECRET=1");
	});
});
