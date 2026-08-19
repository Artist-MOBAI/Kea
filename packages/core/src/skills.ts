import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ExecutionEnv, loadSkills, type Skill, type SkillDiagnostic } from "@earendil-works/pi-agent-core";

// Built-in skills directory: the first candidate that exists, else undefined (caller skips silently).
// Candidate order: KEA_SKILLS_DIR env var → source-tree relative path (dev) → skills/ next to the executable.
export function builtinSkillsDir(): string | undefined {
	const candidates: string[] = [];
	const fromEnv = process.env.KEA_SKILLS_DIR;
	if (fromEnv) candidates.push(fromEnv);
	candidates.push(join(import.meta.dirname ?? ".", "..", "..", "..", "skills"));
	candidates.push(join(dirname(process.execPath), "skills"));
	for (const dir of candidates) {
		if (existsSync(dir)) return dir;
	}
	return undefined;
}

export interface LoadedSkills {
	skills: Skill[];
	diagnostics: SkillDiagnostic[];
}

// Load skills: built-in + user-level (~/.agents) always load; project-level directories load only in a trusted
// workspace (same gate as MCP/hooks) — project skills inject into the system prompt, so a malicious repo could
// steer the agent through them.
export async function loadAllSkills(env: ExecutionEnv, cwd: string, trusted = false): Promise<LoadedSkills> {
	const projectDirs = trusted ? [join(cwd, ".kea", "skills"), join(cwd, ".agents", "skills")] : [];
	const dirs = [...projectDirs, join(homedir(), ".agents", "skills")];
	const { skills: userSkills, diagnostics: userDiagnostics } = await loadSkills(env, dirs);
	const builtinDir = builtinSkillsDir();
	const { skills: builtin, diagnostics: builtinDiagnostics } = builtinDir
		? await loadSkills(env, builtinDir)
		: { skills: [] as Skill[], diagnostics: [] as SkillDiagnostic[] };

	const seen = new Set<string>();
	const skills: Skill[] = [];
	for (const skill of [...userSkills, ...builtin]) {
		if (seen.has(skill.name)) continue;
		seen.add(skill.name);
		skills.push(skill);
	}
	return { skills, diagnostics: [...userDiagnostics, ...builtinDiagnostics] };
}
