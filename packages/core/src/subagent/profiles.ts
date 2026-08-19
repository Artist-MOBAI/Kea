import { join } from "node:path";
import { z } from "zod";
import {
	SUBAGENT_JUDGE_WALL_CLOCK_MS,
	SUBAGENT_PLANNER_WALL_CLOCK_MS,
	SUBAGENT_READER_WALL_CLOCK_MS,
	SUBAGENT_WRITER_WALL_CLOCK_MS,
} from "../timeouts.ts";

export const ProfileSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),

	tools: z.array(z.string()).optional(),
	spawn: z.boolean().optional(),
	budget: z
		.object({
			maxTurns: z.number().int().positive().optional(),
			wallClockMs: z.number().positive().optional(),
		})
		.optional(),
	systemPromptExtra: z.string().optional(),
});

export type Profile = z.infer<typeof ProfileSchema>;

export const BUILTIN_PROFILES: readonly Profile[] = [
	{ name: "experimenter", description: "Full-permission default role" },
	{
		name: "reader",
		description: "Read-only investigation (literature/file scanning)",
		tools: ["read", "grep", "glob"],
		budget: { maxTurns: 15, wallClockMs: SUBAGENT_READER_WALL_CLOCK_MS },
	},
	{
		name: "writer",
		description: "Can write files, no shell",
		tools: ["read", "grep", "glob", "write", "edit"],
		budget: { maxTurns: 20, wallClockMs: SUBAGENT_WRITER_WALL_CLOCK_MS },
	},
	{
		name: "planner",
		description: "Read-only planner that can delegate to nested subagents",
		tools: ["read", "grep", "glob"],
		spawn: true,
		// wall-clock covers waiting on nested readers; the budget leaves room for sequential delegation plus synthesis
		budget: { maxTurns: 40, wallClockMs: SUBAGENT_PLANNER_WALL_CLOCK_MS },
	},
	{
		name: "judge",
		description:
			"Read-only independent judge (scores candidates and decides convergence; never generates or delegates)",
		tools: ["read", "grep", "glob"],
		budget: { maxTurns: 10, wallClockMs: SUBAGENT_JUDGE_WALL_CLOCK_MS },
	},
];

export async function loadProfiles(cwd: string, opts: { trusted?: boolean } = {}): Promise<Map<string, Profile>> {
	const profiles = new Map<string, Profile>();
	for (const profile of BUILTIN_PROFILES) profiles.set(profile.name, profile);

	// trust gate as for hooks/MCP: an untrusted project must not shape subagent prompts via systemPromptExtra
	if (opts.trusted === false) return profiles;

	const dir = join(cwd, ".kea", "profiles");
	const glob = new Bun.Glob("*.json");
	const files: string[] = [];
	try {
		for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) files.push(file);
	} catch {
		return profiles;
	}
	for (const file of files) {
		try {
			const parsed = ProfileSchema.parse(await Bun.file(join(dir, file)).json());
			profiles.set(parsed.name, parsed);
		} catch (err) {
			// a broken profile file must be visible, not silently indistinguishable from "unknown profile"
			console.error(
				`[kea] profile parse failed (${join(dir, file)}): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	return profiles;
}

export function resolveProfile(profiles: Map<string, Profile>, name?: string): Profile {
	// no-profile default is the BUILT-IN experimenter, never a user override with the same name
	if (!name) return BUILTIN_PROFILES[0] as Profile;
	const found = profiles.get(name);
	if (!found) throw new Error(`unknown profile "${name}". Available: ${[...profiles.keys()].join(", ")}`);
	return found;
}
