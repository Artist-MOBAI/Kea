import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { authStorePath, FileCredentialStore } from "../src/auth-store.ts";
import { runDoctor } from "../src/doctor.ts";
import { loadBackendsConfig, loadBackendsConfigDetailed } from "../src/execution/backends-config.ts";
import { trustFolder } from "../src/trust.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

// the test machine may hold real keys; clear the known ones before asserting ✗
function withCleanModelEnv<T>(fn: () => Promise<T>): Promise<T> {
	const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MOONSHOT_API_KEY", "GEMINI_API_KEY"];
	const saved: Record<string, string | undefined> = {};
	for (const k of keys) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	return fn().finally(() => {
		for (const k of keys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});
}

// isolate KEA_HOME: doctor reads ~/.kea/auth.json and the trust ledger — never touch the real home
async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
	const home = await mkdtemp(join(tmpdir(), "kea2-doctor-home-"));
	const prev = process.env.KEA_HOME;
	process.env.KEA_HOME = home;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.KEA_HOME;
		else process.env.KEA_HOME = prev;
		await rm(home, { recursive: true, force: true });
	}
}

describe("loadBackendsConfig diagnostics (E5)", () => {
	test("absent file → no backends, no errors", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
		expect(await loadBackendsConfigDetailed(workdir)).toEqual({ backends: [], errors: [] });
	});

	test("valid file parses; broken JSON surfaces a diagnostic instead of silent []", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
		const path = join(workdir, ".kea", "backends.json");

		await Bun.write(
			path,
			JSON.stringify({ backends: [{ type: "ssh", name: "hpc", config: { host: "hpc.example" } }] }),
		);
		const good = await loadBackendsConfigDetailed(workdir);
		expect(good.errors).toEqual([]);
		expect(good.backends).toHaveLength(1);

		await Bun.write(path, "{ definitely not json");
		const bad = await loadBackendsConfigDetailed(workdir);
		expect(bad.backends).toEqual([]);
		expect(bad.errors).toHaveLength(1);
		expect(bad.errors[0]).toContain("not valid JSON");

		// schema validation failures also surface, not swallowed as none configured
		await Bun.write(path, JSON.stringify({ backends: [{ type: "carrier-pigeon", config: {} }] }));
		const invalid = await loadBackendsConfigDetailed(workdir);
		expect(invalid.backends).toEqual([]);
		expect(invalid.errors[0]).toContain("failed validation");

		// legacy best-effort callers still get [] (kernel unaffected)
		expect(await loadBackendsConfig(workdir)).toEqual([]);
	});
});

describe("runDoctor (D1 + E5)", () => {
	test("python3 missing → not-found check reported, runDoctor does not reject", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
		// Bun.spawn throws synchronously for a missing executable (PATH is snapshotted at process start),
		// so monkey-patch to reproduce the not-found error
		const origSpawn = Bun.spawn;
		(Bun as { spawn: unknown }).spawn = () => {
			throw new Error('Executable not found in $PATH: "python3"');
		};
		try {
			const checks = await runDoctor(workdir);
			const py = checks.find((c) => c.name === "python3");
			expect(py).toBeDefined();
			expect(py?.ok).toBe(false);
			expect(py?.detail).toBe("not found");
			expect(py?.hint).toContain("python3");
		} finally {
			(Bun as { spawn: unknown }).spawn = origSpawn;
		}
	}, 20_000);

	test("broken backends.json → doctor reports the real error, not 'none configured'", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
		await Bun.write(join(workdir, ".kea", "backends.json"), "{ nope");
		const checks = await runDoctor(workdir);
		const rb = checks.find((c) => c.name === "remote backends");
		expect(rb?.ok).toBe(false);
		expect(rb?.detail).toContain("not valid JSON");
		expect(rb?.hint).toContain("backends.json");
	}, 20_000);

	test("valid backends.json and absent file keep the check green", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
		let checks = await runDoctor(workdir);
		expect(checks.find((c) => c.name === "remote backends")).toMatchObject({ ok: true, detail: "none configured" });

		await Bun.write(
			join(workdir, ".kea", "backends.json"),
			JSON.stringify({ backends: [{ type: "ssh", config: { host: "hpc.example" } }] }),
		);
		checks = await runDoctor(workdir);
		expect(checks.find((c) => c.name === "remote backends")).toMatchObject({
			ok: true,
			detail: "1 backend(s) in .kea/backends.json",
		});
	}, 20_000);

	test("broken .kea/mcp.json → mcp config check reports the real error, not 'none configured' (G9)", async () => {
		await withIsolatedHome(async () => {
			workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
			await trustFolder(workdir);
			await Bun.write(join(workdir, ".kea", "mcp.json"), "{ nope");
			let checks = await runDoctor(workdir);
			const mcp = checks.find((c) => c.name === "mcp config");
			expect(mcp?.ok).toBe(false);
			expect(mcp?.detail).toContain("not valid JSON");
			expect(mcp?.hint).toContain("mcp.json");

			// per-entry validation failures surface too, not just invalid JSON
			await Bun.write(
				join(workdir, ".kea", "mcp.json"),
				JSON.stringify({ mcpServers: { bad: { nope: true }, good: { command: "mpmcp" } } }),
			);
			checks = await runDoctor(workdir);
			const mcp2 = checks.find((c) => c.name === "mcp config");
			expect(mcp2?.ok).toBe(false);
			expect(mcp2?.detail).toContain('server "bad"');
		});
	}, 20_000);

	test("valid/absent mcp.json keeps the check green", async () => {
		await withIsolatedHome(async () => {
			workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
			await trustFolder(workdir);
			let checks = await runDoctor(workdir);
			expect(checks.find((c) => c.name === "mcp config")).toMatchObject({ ok: true, detail: "none configured" });

			await Bun.write(join(workdir, ".kea", "mcp.json"), JSON.stringify({ mcpServers: { mp: { command: "mpmcp" } } }));
			checks = await runDoctor(workdir);
			expect(checks.find((c) => c.name === "mcp config")).toMatchObject({
				ok: true,
				detail: "1 server(s) in .kea/mcp.json",
			});
		});
	}, 20_000);
});

describe("runDoctor model credentials env list (F1)", () => {
	test("Google accepts only GEMINI_API_KEY (pi-ai google provider does not read GOOGLE_API_KEY)", async () => {
		await withIsolatedHome(async () => {
			workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
			const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MOONSHOT_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
			const saved: Record<string, string | undefined> = {};
			for (const k of keys) {
				saved[k] = process.env[k];
				delete process.env[k];
			}
			try {
				// GOOGLE_API_KEY alone does not count as a credential
				process.env.GOOGLE_API_KEY = "sk-google";
				let checks = await runDoctor(workdir);
				expect(checks.find((c) => c.name === "model credentials")?.ok).toBe(false);

				delete process.env.GOOGLE_API_KEY;
				process.env.GEMINI_API_KEY = "sk-gemini";
				checks = await runDoctor(workdir);
				const creds = checks.find((c) => c.name === "model credentials");
				expect(creds?.ok).toBe(true);
				expect(creds?.detail).toContain("GEMINI_API_KEY");
			} finally {
				for (const k of keys) {
					if (saved[k] === undefined) delete process.env[k];
					else process.env[k] = saved[k];
				}
			}
		});
	}, 20_000);
});

describe("runDoctor custom models checks (C1)", () => {
	test("missing models.json → no custom-model checks", async () => {
		workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
		const checks = await runDoctor(workdir);
		expect(checks.find((c) => c.name === "custom models config")).toBeUndefined();
		expect(checks.some((c) => c.name.startsWith("credential ("))).toBe(false);
	}, 20_000);

	test("models.json invalid JSON → check fails and yields no credential checks", async () => {
		await withIsolatedHome(async () => {
			workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
			await trustFolder(workdir);
			await Bun.write(join(workdir, ".kea", "models.json"), "{ nope");
			const checks = await runDoctor(workdir);
			expect(checks.find((c) => c.name === "custom models config")).toMatchObject({
				ok: false,
				detail: "not valid JSON",
			});
			expect(checks.some((c) => c.name.startsWith("credential ("))).toBe(false);
		});
	}, 20_000);

	test("models.json schema violation → check fails with a reason", async () => {
		await withIsolatedHome(async () => {
			workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
			await trustFolder(workdir);
			await Bun.write(join(workdir, ".kea", "models.json"), JSON.stringify({ providers: [{ id: "Bad Id!" }] }));
			const checks = await runDoctor(workdir);
			const cm = checks.find((c) => c.name === "custom models config");
			expect(cm?.ok).toBe(false);
			expect(cm?.detail).toContain("schema violation");
		});
	}, 20_000);

	test("credential source: stored key first, env fallback, ✗ when neither (reports only the source label)", async () => {
		await withIsolatedHome(async () => {
			workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
			await trustFolder(workdir);
			await Bun.write(
				join(workdir, ".kea", "models.json"),
				JSON.stringify({
					providers: [
						{ id: "storedprov", baseUrl: "https://a.example/v1", models: [{ id: "m" }] },
						{ id: "envprov", baseUrl: "https://b.example/v1", apiKeyEnv: "KEA_TEST_DOCTOR_KEY", models: [{ id: "m" }] },
						{ id: "bareprov", baseUrl: "https://c.example/v1", models: [{ id: "m" }] },
					],
				}),
			);
			await new FileCredentialStore().modify("storedprov", async () => ({ type: "api_key", key: "sk-stored" }));
			process.env.KEA_TEST_DOCTOR_KEY = "sk-env";
			try {
				const checks = await runDoctor(workdir);
				expect(checks.find((c) => c.name === "custom models config")).toMatchObject({
					ok: true,
					detail: "3 provider(s) in .kea/models.json",
				});
				expect(checks.find((c) => c.name === "credential (storedprov)")).toMatchObject({
					ok: true,
					detail: "stored key",
				});
				expect(checks.find((c) => c.name === "credential (envprov)")).toMatchObject({
					ok: true,
					detail: "env KEA_TEST_DOCTOR_KEY",
				});
				const bare = checks.find((c) => c.name === "credential (bareprov)");
				expect(bare?.ok).toBe(false);
				expect(bare?.hint).toContain("bareprov");
				// stored keys count toward the top-level check, and the key itself is never leaked
				const creds = checks.find((c) => c.name === "model credentials");
				expect(creds?.ok).toBe(true);
				expect(creds?.detail).toContain("stored: storedprov");
				expect(creds?.detail).not.toContain("sk-stored");
			} finally {
				delete process.env.KEA_TEST_DOCTOR_KEY;
			}
		});
	}, 20_000);

	test("stored-credential label accuracy: empty-key api_key entries do not count as coverage; fall back to the env check (F5)", async () => {
		await withIsolatedHome(() =>
			withCleanModelEnv(async () => {
				workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
				await trustFolder(workdir);
				await Bun.write(
					join(workdir, ".kea", "models.json"),
					JSON.stringify({
						providers: [
							{
								id: "keyless-env",
								baseUrl: "https://a.example/v1",
								apiKeyEnv: "KEA_TEST_DOCTOR_KEY2",
								models: [{ id: "m" }],
							},
							{ id: "keyless-bare", baseUrl: "https://b.example/v1", models: [{ id: "m" }] },
						],
					}),
				);
				// api_key entries with no key / empty key (hand-edited auth.json may have them)
				await new FileCredentialStore().modify("keyless-env", async () => ({ type: "api_key" }));
				await new FileCredentialStore().modify("keyless-bare", async () => ({ type: "api_key", key: "" }));
				process.env.KEA_TEST_DOCTOR_KEY2 = "sk-env";
				try {
					const checks = await runDoctor(workdir);
					expect(checks.find((c) => c.name === "credential (keyless-env)")).toMatchObject({
						ok: true,
						detail: "env KEA_TEST_DOCTOR_KEY2",
					});
					const bare = checks.find((c) => c.name === "credential (keyless-bare)");
					expect(bare?.ok).toBe(false);
					expect(bare?.detail).toBe("no stored key and no API key in environment");
					expect(checks.find((c) => c.name === "model credentials")?.ok).toBe(false);
				} finally {
					delete process.env.KEA_TEST_DOCTOR_KEY2;
				}
			}),
		);
	}, 20_000);

	test("hand-written oauth entry: not credential coverage; blocks the provider per pi semantics (env cannot save it) (F5)", async () => {
		await withIsolatedHome(() =>
			withCleanModelEnv(async () => {
				workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
				await trustFolder(workdir);
				await Bun.write(
					join(workdir, ".kea", "models.json"),
					JSON.stringify({
						providers: [
							{
								id: "oauthprov",
								baseUrl: "https://a.example/v1",
								apiKeyEnv: "KEA_TEST_DOCTOR_KEY3",
								models: [{ id: "m" }],
							},
						],
					}),
				);
				// modify() refuses to write oauth, so plant a ledger entry to simulate hand-editing
				await Bun.write(
					authStorePath(),
					JSON.stringify({ oauthprov: { type: "oauth", refresh: "r", access: "a", expires: 1e12 } }),
				);
				process.env.KEA_TEST_DOCTOR_KEY3 = "sk-env";
				try {
					const checks = await runDoctor(workdir);
					const cred = checks.find((c) => c.name === "credential (oauthprov)");
					expect(cred?.ok).toBe(false);
					expect(cred?.detail).toContain("stored oauth entry blocks this provider");
					expect(cred?.hint).toContain("oauthprov");
					expect(checks.find((c) => c.name === "model credentials")?.ok).toBe(false);
				} finally {
					delete process.env.KEA_TEST_DOCTOR_KEY3;
				}
			}),
		);
	}, 20_000);

	test("untrusted workspace: custom-models checks carry the trust-gate annotation; it disappears once trusted (F6)", async () => {
		await withIsolatedHome(async () => {
			workdir = await mkdtemp(join(tmpdir(), "kea2-doctor-"));
			await Bun.write(
				join(workdir, ".kea", "models.json"),
				JSON.stringify({ providers: [{ id: "prov", baseUrl: "https://a.example/v1", models: [{ id: "m" }] }] }),
			);
			let checks = await runDoctor(workdir);
			expect(checks.find((c) => c.name === "workspace trust")?.ok).toBe(false);
			expect(checks.find((c) => c.name === "custom models config")?.detail).toBe(
				"1 provider(s) in .kea/models.json (gated by workspace trust)",
			);
			expect(checks.find((c) => c.name === "credential (prov)")?.detail).toContain("(gated by workspace trust)");

			await trustFolder(workdir);
			checks = await runDoctor(workdir);
			expect(checks.find((c) => c.name === "custom models config")?.detail).toBe("1 provider(s) in .kea/models.json");
			expect(checks.find((c) => c.name === "credential (prov)")?.detail).not.toContain("gated");
		});
	}, 20_000);
});
