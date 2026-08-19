import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";
import { getOrThrow } from "@earendil-works/pi-agent-core";
import { afterAll, describe, expect, test } from "vitest";
import { createExecutionEnv } from "../src/env.ts";
import { BASH_DEFAULT_TIMEOUT_S, BASH_MAX_TIMEOUT_S, bashEffectiveTimeout, createBaseTools } from "../src/tools.ts";

const dirs: string[] = [];

afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function setup(): string {
	const dir = mkdtempSync(join(tmpdir(), "kea2-tools-"));
	dirs.push(dir);
	return dir;
}

async function tool(dir: string, name: string) {
	const { env } = await createExecutionEnv(dir);
	const found = createBaseTools(env).find((t) => t.name === name);
	if (!found) throw new Error(`tool ${name} missing`);
	return found;
}

interface RecordedExec {
	command: string;
	options?: { cwd?: string; timeout?: number; abortSignal?: AbortSignal };
}

// ExecutionEnv double for the search tools: "command -v rg" answers from rgProbe, every other command
// from onExec; all calls are recorded so tests can assert exit-code handling and no fallback rescan.
function fakeSearchEnv(spec: {
	rgProbe?: boolean;
	onExec?: (command: string) => { stdout?: string; stderr?: string; exitCode?: number };
	absolute?: string;
}): ExecutionEnv & { calls: RecordedExec[] } {
	const calls: RecordedExec[] = [];
	const env = {
		calls,
		async exec(command: string, options?: { cwd?: string; timeout?: number; abortSignal?: AbortSignal }) {
			calls.push({ command, options });
			if (command === "command -v rg") {
				const exitCode = spec.rgProbe === false ? 1 : 0;
				return { ok: true as const, value: { stdout: "", stderr: "", exitCode } };
			}
			const r = spec.onExec?.(command) ?? {};
			return {
				ok: true as const,
				value: { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 },
			};
		},
		async absolutePath(path: string) {
			return { ok: true as const, value: spec.absolute ?? path };
		},
	};
	return env as unknown as ExecutionEnv & { calls: RecordedExec[] };
}

function searchToolFrom(env: ExecutionEnv, name: "grep" | "glob") {
	const found = createBaseTools(env).find((t) => t.name === name);
	if (!found) throw new Error(`tool ${name} missing`);
	return found;
}

function resultText(result: unknown): string {
	return ((result as { content: Array<{ text: string }> }).content[0] ?? { text: "" }).text;
}

describe("grep sensitive-file result filtering", () => {
	test("lines matching sensitive files are filtered, ordinary matches kept", async () => {
		const dir = setup();
		writeFileSync(join(dir, ".env"), "SECRET=abc123");
		writeFileSync(join(dir, "app.txt"), "SECRET=visible");
		const grep = await tool(dir, "grep");
		const result = await grep.execute("id", { pattern: "SECRET" } as never, undefined, undefined);
		const text = JSON.stringify(result);
		expect(text).toContain("app.txt");
		expect(text).not.toContain("abc123");
	});

	test("single-file grep of sensitive path refused (path:content bypasses line-filter); plain file OK", async () => {
		const dir = setup();
		writeFileSync(join(dir, ".env"), "SECRET=abc123");
		writeFileSync(join(dir, "app.txt"), "SECRET=visible");
		const grep = await tool(dir, "grep");
		await expect(
			grep.execute("id", { pattern: "SECRET", path: join(dir, ".env") } as never, undefined, undefined),
		).rejects.toThrow(/refused: known secret file/);
		const ok = await grep.execute(
			"id",
			{ pattern: "SECRET", path: join(dir, "app.txt") } as never,
			undefined,
			undefined,
		);
		expect(JSON.stringify(ok)).toContain("SECRET=visible");
	});
});

describe("glob two-level cap messages", () => {
	test("over 100 results: truncation notice shown (scan hard cap not reached)", async () => {
		const dir = setup();
		for (let i = 0; i < 120; i++) writeFileSync(join(dir, `f${i}.txt`), "x");
		const glob = await tool(dir, "glob");
		const result = await glob.execute("id", { pattern: "*.txt" } as never, undefined, undefined);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("[capped at 100 results]");
		expect(text).not.toContain("scan stopped");
		expect(result.details).toEqual({ count: 100 });
	});

	test("reaching the scan hard cap 400: message states the scan stopped early", async () => {
		const dir = setup();
		for (let i = 0; i < 420; i++) writeFileSync(join(dir, `f${i}.txt`), "x");
		const glob = await tool(dir, "glob");
		const result = await glob.execute("id", { pattern: "*.txt" } as never, undefined, undefined);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("[capped at 100 results; scan stopped at 400 matches]");
	}, 15_000);
});

describe("bash timeout guard (pathological commands must not stall a turn forever)", () => {
	test("no timeout passed uses the default; explicit values clamped to the cap", () => {
		expect(bashEffectiveTimeout(undefined)).toBe(BASH_DEFAULT_TIMEOUT_S);
		expect(bashEffectiveTimeout(10)).toBe(10);
		expect(bashEffectiveTimeout(BASH_MAX_TIMEOUT_S)).toBe(BASH_MAX_TIMEOUT_S);
		expect(bashEffectiveTimeout(BASH_MAX_TIMEOUT_S + 1)).toBe(BASH_MAX_TIMEOUT_S);
		expect(bashEffectiveTimeout(999_999)).toBe(BASH_MAX_TIMEOUT_S);
	});

	test("timeout <= 0 clamped to the 1s floor (must not fall back to pi's no-timeout semantics)", () => {
		expect(bashEffectiveTimeout(0)).toBe(1);
		expect(bashEffectiveTimeout(-5)).toBe(1);
	});

	test("bash tool description states default/max timeouts (model can pass timeout for long commands)", async () => {
		const dir = setup();
		const bash = await tool(dir, "bash");
		expect(bash.description).toContain(`${BASH_DEFAULT_TIMEOUT_S}s`);
		expect(bash.description).toContain(`${BASH_MAX_TIMEOUT_S}s`);
	});

	test("base tool description contract lines (kimi triad: fresh shell / REFUSED / dedup rules)", async () => {
		const dir = setup();
		const bash = await tool(dir, "bash");
		expect(bash.description).toContain("FRESH shell");
		expect(bash.description).toContain("do NOT persist between calls");
		expect(bash.description).toContain("use read");
		const read = await tool(dir, "read");
		expect(read.description).toContain("REFUSED");
		expect(read.description).toContain("do NOT glob or ls first");
		const write = await tool(dir, "write");
		expect(write.description).toContain("REFUSED");
		expect(write.description).toContain(".kea");
		expect(write.description).toContain("use edit");
		const edit = await tool(dir, "edit");
		expect(edit.description).toContain("EXACTLY ONE");
		expect(edit.description).toContain("Read the file before editing");
		const grep = await tool(dir, "grep");
		expect(grep.description).toContain("INSTEAD of running grep/rg through bash");
		const glob = await tool(dir, "glob");
		expect(glob.description).toContain("at most 100 results");
	});

	test("fast commands still run normally with the default timeout injected (wrapper keeps semantics)", async () => {
		const dir = setup();
		const bash = await tool(dir, "bash");
		const result = await bash.execute("id", { command: "echo bash-timeout-guard-ok" } as never, undefined, undefined);
		const text = JSON.stringify(result);
		expect(text).toContain("bash-timeout-guard-ok");
	});
});

describe("ledger integrity guard (.kea changes only through research tools)", () => {
	test("write/edit directly to .kea/mobai.json refused (anti-sycophancy / criteria tampering)", async () => {
		const dir = setup();
		const write = await tool(dir, "write");
		await expect(
			write.execute("id", { path: join(dir, ".kea", "mobai.json"), content: "{}" } as never, undefined, undefined),
		).rejects.toThrow(/only through the research tools/);
		const edit = await tool(dir, "edit");
		await expect(
			edit.execute(
				"id",
				{ path: join(dir, ".kea", "mobai.json"), oldText: "a", newText: "b" } as never,
				undefined,
				undefined,
			),
		).rejects.toThrow(/only through the research tools/);
	});

	test("~/.kea trust ledger protected too (anti self-escalation); neighbor name (.keystore) unharmed", async () => {
		const dir = setup();
		const write = await tool(dir, "write");
		await expect(
			write.execute(
				"id",
				{ path: join(dir, "home", ".kea", "trusted-folders.json"), content: "{}" } as never,
				undefined,
				undefined,
			),
		).rejects.toThrow(/only through the research tools/);
		const ok = await write.execute(
			"id",
			{ path: join(dir, ".keystore", "notes.txt"), content: "x" } as never,
			undefined,
			undefined,
		);
		expect(JSON.stringify(ok)).not.toContain("refused");
	});

	test("plans namespace is the only writable exemption (deadlock regression: plan target unwritable)", async () => {
		const dir = setup();
		const write = await tool(dir, "write");
		const planWrite = await write.execute(
			"id",
			{ path: join(dir, "home", ".kea", "plans", "sess-1", "plan.md"), content: "# plan" } as never,
			undefined,
			undefined,
		);
		expect(JSON.stringify(planWrite)).not.toContain("refused");
		const workspacePlan = await write.execute(
			"id",
			{ path: join(dir, ".kea", "plans", "sess-1", "plan.md"), content: "# plan" } as never,
			undefined,
			undefined,
		);
		expect(JSON.stringify(workspacePlan)).not.toContain("refused");
	});

	test("plans exemption is namespace-exact: neighbor names and ledger subtrees still refused", async () => {
		const dir = setup();
		const write = await tool(dir, "write");
		for (const path of [
			join(dir, ".kea", "plans-x", "evil.md"),
			join(dir, ".kea", "mobai", "sess-1", "program.json"),
			join(dir, ".kea", "program.json"),
			join(dir, ".kea", "jobs", "j1", "meta.json"),
		]) {
			await expect(write.execute("id", { path, content: "{}" } as never, undefined, undefined)).rejects.toThrow(
				/only through the research tools/,
			);
		}
	});

	test("`..` escapes folded before judging (literal path; join would normalize .. away)", async () => {
		const dir = setup();
		const write = await tool(dir, "write");
		await expect(
			write.execute("id", { path: `${dir}/.kea/plans/../mobai/x.json`, content: "{}" } as never, undefined, undefined),
		).rejects.toThrow(/only through the research tools/);
		await expect(
			write.execute(
				"id",
				{ path: `${dir}/home/.kea/plans/../../trusted-folders.json`, content: "{}" } as never,
				undefined,
				undefined,
			),
		).rejects.toThrow(/only through the research tools/);
		// resolved-path branch: an existing target lets realpath resolve the traversal before the guard
		mkdirSync(join(dir, ".kea", "mobai"), { recursive: true });
		writeFileSync(join(dir, ".kea", "mobai", "x.json"), "{}");
		const edit = await tool(dir, "edit");
		await expect(
			edit.execute(
				"id",
				{ path: `${dir}/.kea/plans/../mobai/x.json`, oldText: "{", newText: "[" } as never,
				undefined,
				undefined,
			),
		).rejects.toThrow(/only through the research tools/);
		// the folded plans namespace itself stays writable (folding must not over-reject)
		const ok = await write.execute(
			"id",
			{ path: `${dir}/.kea/plans/sess-1/plan.md`, content: "# plan" } as never,
			undefined,
			undefined,
		);
		expect(JSON.stringify(ok)).not.toContain("refused");
	});

	test("case folding: on case-insensitive FS `.KEA` is still the ledger tree, `.kea/PLANS` still plans", async () => {
		const dir = setup();
		const write = await tool(dir, "write");
		await expect(
			write.execute("id", { path: join(dir, ".KEA", "mobai", "x.json"), content: "{}" } as never, undefined, undefined),
		).rejects.toThrow(/only through the research tools/);
		await expect(
			write.execute("id", { path: `${dir}/.KeA/PlAnS/../mobai/y.json`, content: "{}" } as never, undefined, undefined),
		).rejects.toThrow(/only through the research tools/);
		// folding must not over-reject: `.kea/PLANS/**` is the plans namespace and stays writable
		const ok = await write.execute(
			"id",
			{ path: join(dir, ".kea", "PLANS", "sess-1", "plan.md"), content: "# plan" } as never,
			undefined,
			undefined,
		);
		expect(JSON.stringify(ok)).not.toContain("refused");
	});

	test("reading the .kea ledger stays allowed (guard is write-only)", async () => {
		const dir = setup();
		const { env } = await createExecutionEnv(dir);
		mkdirSync(join(dir, ".kea"));
		writeFileSync(join(dir, ".kea", "note.txt"), "ledger-readable");
		const read = createBaseTools(env).find((t) => t.name === "read");
		const result = await read?.execute("id", { path: join(dir, ".kea", "note.txt") } as never, undefined, undefined);
		expect(JSON.stringify(result)).toContain("ledger-readable");
	});
});

describe("grep exit-code semantics (rg first; exit 1 = no match, no rescan; exit >= 2 errors)", () => {
	test("rg exit 1 (no match) → 'No matches.', search command runs exactly once (no fallback rescan)", async () => {
		const env = fakeSearchEnv({ rgProbe: true, onExec: () => ({ exitCode: 1 }) });
		const grep = searchToolFrom(env, "grep");
		const text = resultText(await grep.execute("id", { pattern: "nothing" } as never, undefined, undefined));
		expect(text).toBe("No matches.");
		const searchCalls = env.calls.filter((c) => c.command !== "command -v rg");
		expect(searchCalls).toHaveLength(1);
		expect(searchCalls[0]?.command).toContain("rg ");
		expect(env.calls.some((c) => c.command.startsWith("grep"))).toBe(false);
	});

	test("rg exit 2 (invalid regex) → throw carrying exit code and stderr digest (no false 'No matches')", async () => {
		const env = fakeSearchEnv({
			rgProbe: true,
			onExec: () => ({ stdout: "", stderr: "rg: regex parse error: unclosed character class", exitCode: 2 }),
		});
		const grep = searchToolFrom(env, "grep");
		await expect(grep.execute("id", { pattern: "[unclosed" } as never, undefined, undefined)).rejects.toThrow(
			/grep failed \(exit 2\): rg: regex parse error/,
		);
	});

	test("no rg (command -v fails) → fallback grep -rnE returns matches; grep exit 2 also errors", async () => {
		const env = fakeSearchEnv({
			rgProbe: false,
			onExec: () => ({ stdout: "app.txt:1:hit", stderr: "", exitCode: 0 }),
		});
		const grep = searchToolFrom(env, "grep");
		const text = resultText(await grep.execute("id", { pattern: "hit" } as never, undefined, undefined));
		expect(text).toContain("app.txt:1:hit");
		expect(env.calls.some((c) => c.command.startsWith("grep -rnE"))).toBe(true);

		const envErr = fakeSearchEnv({
			rgProbe: false,
			onExec: () => ({ stdout: "", stderr: "grep: Invalid regular expression", exitCode: 2 }),
		});
		await expect(
			searchToolFrom(envErr, "grep").execute("id", { pattern: "(" } as never, undefined, undefined),
		).rejects.toThrow(/grep failed \(exit 2\): grep: Invalid/);
	});

	test("rg carries --hidden; sensitive lines still filtered (dotfiles searchable, filter backstops)", async () => {
		const env = fakeSearchEnv({
			rgProbe: true,
			onExec: () => ({
				stdout: "./.env:1:SECRET=abc123\n./app.txt:1:SECRET=visible",
				stderr: "",
				exitCode: 0,
			}),
		});
		const grep = searchToolFrom(env, "grep");
		const text = resultText(await grep.execute("id", { pattern: "SECRET" } as never, undefined, undefined));
		expect(env.calls.find((c) => c.command.startsWith("rg "))?.command).toContain("--hidden");
		expect(text).toContain("app.txt:1:SECRET=visible");
		expect(text).not.toContain("abc123");
	});

	test("real rg: dotfile directories are searchable (--hidden capability)", async () => {
		const dir = setup();
		mkdirSync(join(dir, ".config"));
		writeFileSync(join(dir, ".config", "conf.txt"), "NEEDLE=1");
		const grep = await tool(dir, "grep");
		const result = await grep.execute("id", { pattern: "NEEDLE" } as never, undefined, undefined);
		expect(JSON.stringify(result)).toContain("NEEDLE=1");
	});
});

describe("glob respects ignore files (rg --files enumerates paths)", () => {
	test("files ignored by .gitignore are missed by default; include_ignored:true finds them (real rg)", async () => {
		const dir = setup();
		writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
		writeFileSync(join(dir, "ignored.txt"), "x");
		writeFileSync(join(dir, "keep.txt"), "x");
		const glob = await tool(dir, "glob");
		const def = resultText(await glob.execute("id", { pattern: "*.txt" } as never, undefined, undefined));
		expect(def).toContain("keep.txt");
		expect(def).not.toContain("ignored.txt");
		const incl = resultText(
			await glob.execute("id", { pattern: "*.txt", include_ignored: true } as never, undefined, undefined),
		);
		expect(incl).toContain("ignored.txt");
		expect(incl).toContain("keep.txt");
	});

	test("dist/ build output blocked by .gitignore (regression: Bun.Glob.scan matched dist/**)", async () => {
		const dir = setup();
		writeFileSync(join(dir, ".gitignore"), "dist/\n");
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "out.js"), "x");
		const glob = await tool(dir, "glob");
		const text = resultText(await glob.execute("id", { pattern: "**/*.js" } as never, undefined, undefined));
		expect(text).toBe("No files matched.");
	});

	test("rg exit >= 2 → throw with stderr digest (fake execEnv)", async () => {
		const dir = setup();
		const env = fakeSearchEnv({
			rgProbe: true,
			absolute: dir,
			onExec: () => ({ stdout: "", stderr: "rg: malformed glob", exitCode: 2 }),
		});
		await expect(
			searchToolFrom(env, "glob").execute("id", { pattern: "*.ts" } as never, undefined, undefined),
		).rejects.toThrow(/glob failed \(exit 2\): rg: malformed glob/);
	});

	test("rg --files no match (exit 1) → 'No files matched.' (not an error)", async () => {
		const dir = setup();
		const env = fakeSearchEnv({ rgProbe: true, absolute: dir, onExec: () => ({ exitCode: 1 }) });
		const text = resultText(
			await searchToolFrom(env, "glob").execute("id", { pattern: "*.ts" } as never, undefined, undefined),
		);
		expect(text).toBe("No files matched.");
	});

	test("include_ignored → rg command carries --no-ignore; default does not (fake)", async () => {
		const dir = setup();
		const envIncl = fakeSearchEnv({ rgProbe: true, absolute: dir, onExec: () => ({ exitCode: 1 }) });
		await searchToolFrom(envIncl, "glob").execute(
			"id",
			{ pattern: "*.txt", include_ignored: true } as never,
			undefined,
			undefined,
		);
		expect(envIncl.calls.find((c) => c.command.startsWith("rg --files"))?.command).toContain("--no-ignore");

		const envDef = fakeSearchEnv({ rgProbe: true, absolute: dir, onExec: () => ({ exitCode: 1 }) });
		await searchToolFrom(envDef, "glob").execute("id", { pattern: "*.txt" } as never, undefined, undefined);
		expect(envDef.calls.find((c) => c.command.startsWith("rg --files"))?.command).not.toContain("--no-ignore");
	});

	test("rg paths strip './' prefix (Bun.Glob matching unchanged) and filter sensitive files", async () => {
		const dir = setup();
		const stripEnv = fakeSearchEnv({
			rgProbe: true,
			absolute: dir,
			onExec: () => ({ stdout: "./app.txt", exitCode: 0 }),
		});
		// without the strip, Bun.Glob.match("./app.txt", "*.txt") is false → false "No files matched."
		const text = resultText(
			await searchToolFrom(stripEnv, "glob").execute("id", { pattern: "*.txt" } as never, undefined, undefined),
		);
		expect(text).toBe("app.txt");

		const sensitiveEnv = fakeSearchEnv({
			rgProbe: true,
			absolute: dir,
			onExec: () => ({ stdout: "./auth.json\n./ok.json", exitCode: 0 }),
		});
		const filtered = resultText(
			await searchToolFrom(sensitiveEnv, "glob").execute("id", { pattern: "*.json" } as never, undefined, undefined),
		);
		expect(filtered).toBe("ok.json");
	});

	test("no rg → falls back to Bun.Glob.scan (ignore not honored but functional)", async () => {
		const dir = setup();
		writeFileSync(join(dir, "a.txt"), "x");
		const env = fakeSearchEnv({ rgProbe: false, absolute: dir });
		const text = resultText(
			await searchToolFrom(env, "glob").execute("id", { pattern: "*.txt" } as never, undefined, undefined),
		);
		expect(text).toContain("a.txt");
	});

	test("rg paths sorted by mtime, newest first", async () => {
		const dir = setup();
		writeFileSync(join(dir, "old.txt"), "x");
		await Bun.sleep(20);
		writeFileSync(join(dir, "new.txt"), "x");
		const glob = await tool(dir, "glob");
		const text = resultText(await glob.execute("id", { pattern: "*.txt" } as never, undefined, undefined));
		expect(text.indexOf("new.txt")).toBeLessThan(text.indexOf("old.txt"));
	});
});

describe("bash environment and cwd (kimi alignment)", () => {
	test("shell exec injects non-interactive env vars (NO_COLOR/TERM/GIT_TERMINAL_PROMPT)", async () => {
		const dir = setup();
		const { env } = await createExecutionEnv(dir);
		const result = getOrThrow(await env.exec('echo "$NO_COLOR/$TERM/$GIT_TERMINAL_PROMPT"'));
		expect(result.stdout.trim()).toBe(`1/dumb/${process.env.GIT_TERMINAL_PROMPT ?? "0"}`);
	});

	test.skipIf(!process.env.SHELL?.trim())(
		"shellPath follows $SHELL (commands run under the user's login shell, not fixed /bin/bash)",
		async () => {
			const dir = setup();
			const { env } = await createExecutionEnv(dir);
			// `echo $0` reports the spawned shell itself (ps -p $$ is unreliable: shells exec the last
			// simple command, so $$ becomes ps's own pid)
			const result = getOrThrow(await env.exec("echo $0"));
			expect(result.stdout.trim()).toBe(process.env.SHELL?.trim());
		},
	);

	test("bash tool exposes cwd param, command runs in the given dir; without cwd stays in default dir", async () => {
		const dir = setup();
		mkdirSync(join(dir, "sub"));
		const bash = await tool(dir, "bash");
		expect(JSON.stringify(bash.parameters)).toContain("cwd");
		const inSub = JSON.stringify(
			await bash.execute("id", { command: "pwd", cwd: "sub" } as never, undefined, undefined),
		);
		expect(inSub).toContain("sub");
		const def = JSON.stringify(await bash.execute("id", { command: "pwd" } as never, undefined, undefined));
		expect(def).toContain(basename(dir));
	});
});

describe("tool description determinism (F7, 2026-08-15 prompt audit: prefix-cache invariant)", () => {
	// Official cache order is tools→system→messages: any description change invalidates the whole prefix
	// cache — no per-build values (cwd/timestamps/session id). Two builds in one dir must be byte-identical.
	test("createBaseTools built twice with same args: name→description mapping identical", async () => {
		const dir = setup();
		const a = await createExecutionEnv(dir);
		const b = await createExecutionEnv(dir);
		const first = createBaseTools(a.env).map((t) => [t.name, t.description]);
		const second = createBaseTools(b.env).map((t) => [t.name, t.description]);
		expect(second).toEqual(first);
	});
});
