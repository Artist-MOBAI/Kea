import { afterAll, describe, expect, test } from "vitest";
import { collectDebugBundle } from "../src/tui/commands/debug-export.ts";
import { makeTempDir, removeTempDir } from "./helpers/temp-dir.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await removeTempDir(workdir);
});

describe("export-debug-zip debug bundle collection", () => {
	test("all four artifacts present: doctor/status/jobs/journal stats", async () => {
		workdir = await makeTempDir("kea2-debug-");
		const files = await collectDebugBundle(workdir);
		expect(Object.keys(files).sort()).toEqual(["doctor.txt", "jobs.json", "journal-summary.json", "status.json"]);
		const status = JSON.parse(files["status.json"] ?? "{}") as { version?: string; platform?: string };
		expect(status.version).toBeDefined();
		expect(status.platform).toContain(process.platform);
		expect(JSON.parse(files["jobs.json"] ?? "[]")).toEqual([]);
	});

	test("safety: env secret values are never included", async () => {
		workdir = await makeTempDir("kea2-debug-");
		const secret = process.env.ANTHROPIC_API_KEY;
		if (!secret) return;
		const files = await collectDebugBundle(workdir);
		for (const [name, content] of Object.entries(files)) {
			expect(content, name).not.toContain(secret);
		}
	});
});
