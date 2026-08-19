import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { createExecutionEnv } from "../src/env.ts";
import { builtinSkillsDir, loadAllSkills } from "../src/skills.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

afterEach(() => {
	delete process.env.KEA_SKILLS_DIR;
});

describe("skills loading (after M6 prompt redesign)", () => {
	test("builtin skills dir points at the monorepo root skills/ and all five methodology skills are present", async () => {
		const dir = builtinSkillsDir();
		expect(dir).toBeDefined();
		expect(dir?.endsWith("skills")).toBe(true);
		expect(await Bun.file(join(dir as string, "numerical-optimization", "SKILL.md")).exists()).toBe(true);
		expect(await Bun.file(join(dir as string, "reproduce-protocol", "SKILL.md")).exists()).toBe(true);
		expect(await Bun.file(join(dir as string, "synthesis-validation", "SKILL.md")).exists()).toBe(true);
		expect(await Bun.file(join(dir as string, "systematic-literature-review", "SKILL.md")).exists()).toBe(true);
		expect(await Bun.file(join(dir as string, "structure-novelty", "SKILL.md")).exists()).toBe(true);
	});

	test("builtinSkillsDir candidate order: KEA_SKILLS_DIR env var comes first", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-skillsenv-"));
		process.env.KEA_SKILLS_DIR = workdir;
		expect(builtinSkillsDir()).toBe(workdir);
	});

	test("builtinSkillsDir: falls back to source-tree candidates when the env-var dir is missing", async () => {
		const missing = await mkdtemp(join(tmpdir(), "kea2-skillsmissing-"));
		await rm(missing, { recursive: true, force: true });
		process.env.KEA_SKILLS_DIR = missing;
		const dir = builtinSkillsDir();
		expect(dir).toBeDefined();
		expect(dir).not.toBe(missing);
		expect(await Bun.file(join(dir as string, "reproduce-protocol", "SKILL.md")).exists()).toBe(true);
	});

	test("loadAllSkills merges builtin and project skills when trusted; project wins", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-skills-"));
		await Bun.write(
			join(workdir, ".kea", "skills", "custom-skill", "SKILL.md"),
			"---\nname: custom-skill\ndescription: test skill\n---\nbody\n",
		);
		const { env } = await createExecutionEnv(workdir);
		const { skills } = await loadAllSkills(env, workdir, true);
		const names = skills.map((s) => s.name);
		expect(names).toContain("custom-skill");
		expect(names).toContain("numerical-optimization");
		expect(names).toContain("structure-novelty");
	}, 20_000);

	test("loadAllSkills skips both project-level dirs when untrusted; builtin and user-level are kept", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-skills-"));
		await Bun.write(
			join(workdir, ".kea", "skills", "project-skill", "SKILL.md"),
			"---\nname: project-skill\ndescription: untrusted project skill\n---\nbody\n",
		);
		await Bun.write(
			join(workdir, ".agents", "skills", "agents-skill", "SKILL.md"),
			"---\nname: agents-skill\ndescription: untrusted agents skill\n---\nbody\n",
		);
		const { env } = await createExecutionEnv(workdir);
		const { skills } = await loadAllSkills(env, workdir);
		const names = skills.map((s) => s.name);
		expect(names).not.toContain("project-skill");
		expect(names).not.toContain("agents-skill");
		expect(names).toContain("numerical-optimization");
	}, 20_000);
});
