import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createExecutionEnv } from "../src/env.ts";
import { isSensitiveFile } from "../src/sensitive.ts";
import { createBaseTools } from "../src/tools.ts";

describe("isSensitiveFile (kimi path-access paradigm)", () => {
	test("matches: .env and variants", () => {
		expect(isSensitiveFile(".env")).toBe(true);
		expect(isSensitiveFile("project/.env")).toBe(true);
		expect(isSensitiveFile("config/.env.local")).toBe(true);
		expect(isSensitiveFile("a/b/.env.production")).toBe(true);
	});

	test("matches: SSH private keys and variants", () => {
		expect(isSensitiveFile("/home/u/.ssh/id_rsa")).toBe(true);
		expect(isSensitiveFile("id_ed25519")).toBe(true);
		expect(isSensitiveFile("keys/id_rsa-work")).toBe(true);
		expect(isSensitiveFile("id_rsa_backup.pem")).toBe(true);
		expect(isSensitiveFile("id_ecdsa.old")).toBe(true);
	});

	test("matches: credential files", () => {
		expect(isSensitiveFile("credentials")).toBe(true);
		expect(isSensitiveFile("/home/u/.aws/credentials")).toBe(true);
		expect(isSensitiveFile("x/.gcp/credentials")).toBe(true);
		expect(isSensitiveFile("config/credentials.json".replace(".json", ""))).toBe(true);
		// Kea stores its credential ledger: exact basename auth.json (not covered by the "credentials" prefix rule)
		expect(isSensitiveFile("auth.json")).toBe(true);
		expect(isSensitiveFile("/home/u/.kea/auth.json")).toBe(true);
		// write temps (auth.json.tmp-<pid>-<uuid>) and manual backups (auth.json.bak) are the same ledger
		expect(isSensitiveFile("/home/u/.kea/auth.json.tmp-123-abc")).toBe(true);
		expect(isSensitiveFile("auth.json.bak")).toBe(true);
		expect(isSensitiveFile("AUTH.JSON.TMP-9")).toBe(true);
	});

	test("matches: id_dsa / *.ppk / .netrc / service-account*.json / *.key", () => {
		expect(isSensitiveFile("/home/u/.ssh/id_dsa")).toBe(true);
		expect(isSensitiveFile("keys/id_dsa-work")).toBe(true);
		expect(isSensitiveFile("id_dsa_backup.pem")).toBe(true);
		expect(isSensitiveFile("server.ppk")).toBe(true);
		expect(isSensitiveFile("keys/putty.ppk")).toBe(true);
		expect(isSensitiveFile("/home/u/.netrc")).toBe(true);
		expect(isSensitiveFile("service-account.json")).toBe(true);
		expect(isSensitiveFile("keys/service-account-abc123.json")).toBe(true);
		expect(isSensitiveFile("signing.key")).toBe(true);
		expect(isSensitiveFile("certs/tls.key")).toBe(true);
		expect(isSensitiveFile("PRIVATE.KEY")).toBe(true);
	});

	test("exempts: templates and public keys; ordinary files unharmed", () => {
		expect(isSensitiveFile(".env.example")).toBe(false);
		expect(isSensitiveFile("config/.env.sample")).toBe(false);
		expect(isSensitiveFile(".env.template")).toBe(false);
		expect(isSensitiveFile("id_rsa.pub")).toBe(false);
		expect(isSensitiveFile("id_dsa.pub")).toBe(false);
		expect(isSensitiveFile("id_ed25519.pub")).toBe(false);
		expect(isSensitiveFile("src/main.ts")).toBe(false);
		expect(isSensitiveFile("environment.ts")).toBe(false);
		expect(isSensitiveFile("mycredentials.txt")).toBe(false);
		expect(isSensitiveFile("monkey.txt")).toBe(false);
		expect(isSensitiveFile("keyboard.ts")).toBe(false);
		expect(isSensitiveFile("turkey.md")).toBe(false);
		expect(isSensitiveFile("apikey.txt")).toBe(false);
		expect(isSensitiveFile("account-service.json")).toBe(false);
	});

	test("rename shield: -/_ suffixes and dot variants of id_*/credentials families (renames do not launder)", () => {
		expect(isSensitiveFile("id_rsa-work")).toBe(true);
		expect(isSensitiveFile("id_ed25519_deploy")).toBe(true);
		expect(isSensitiveFile("credentials-prod")).toBe(true);
		expect(isSensitiveFile("secrets/credentials_prod")).toBe(true);
		for (const variant of [".bak", ".backup", ".copy", ".disabled", ".key", ".old", ".orig", ".pem", ".save", ".tmp"]) {
			expect(isSensitiveFile(`id_rsa${variant}`), `id_rsa${variant}`).toBe(true);
			expect(isSensitiveFile(`credentials${variant}`), `credentials${variant}`).toBe(true);
			expect(isSensitiveFile(`keys/id_ecdsa${variant}`), `id_ecdsa${variant}`).toBe(true);
		}
		expect(isSensitiveFile("id_rsa2")).toBe(false);
		expect(isSensitiveFile("mycredentials")).toBe(false);
	});

	test("G9: id_* private key + ≤4-char ext matches (id_rsa.txt fix); credentials keeps fixed variant list", () => {
		expect(isSensitiveFile("id_rsa.txt")).toBe(true);
		expect(isSensitiveFile("keys/id_ed25519.json")).toBe(true);
		expect(isSensitiveFile("id_dsa.KEY")).toBe(true);
		// public keys stay exempt; extensions beyond 4 chars stay outside the rule
		expect(isSensitiveFile("id_rsa.pub")).toBe(false);
		expect(isSensitiveFile("id_rsa.public")).toBe(false);
		// policy pin: credentials.json is deliberately NOT sensitive (family keeps the fixed suffix list)
		expect(isSensitiveFile("credentials.json")).toBe(false);
		expect(isSensitiveFile("id_rsa2")).toBe(false);
	});

	test("deliberately minimal: credentials.json/.npmrc/.pypirc/.pgpass/.htpasswd not included (policy)", () => {
		expect(isSensitiveFile("credentials.json")).toBe(false);
		expect(isSensitiveFile("/home/u/.npmrc")).toBe(false);
		expect(isSensitiveFile("/home/u/.pypirc")).toBe(false);
		expect(isSensitiveFile("/home/u/.pgpass")).toBe(false);
		expect(isSensitiveFile("/etc/.htpasswd")).toBe(false);
	});
});

describe("sensitive-guard symlink bypass prevention (read/write/edit recheck via realpath)", () => {
	let dir: string;

	afterAll(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	test("symlink -> .env refused for read/write/edit alike", async () => {
		dir = await mkdtemp(join(tmpdir(), "kea2-sens-link-"));
		await Bun.write(join(dir, ".env"), "SECRET=1");
		await symlink(join(dir, ".env"), join(dir, "notes.txt"));

		const { env } = await createExecutionEnv(dir);
		const tools = createBaseTools(env);
		for (const name of ["read", "write", "edit"]) {
			const tool = tools.find((t) => t.name === name);
			if (!tool) throw new Error(`tool ${name} missing`);
			await expect(tool.execute("t1", { path: join(dir, "notes.txt") } as never, undefined, undefined)).rejects.toThrow(
				/refused/,
			);
		}
	});

	test("symlinks to ordinary files and dangling links unaffected", async () => {
		dir = await mkdtemp(join(tmpdir(), "kea2-sens-link2-"));
		await Bun.write(join(dir, "data.txt"), "hello");
		await symlink(join(dir, "data.txt"), join(dir, "link.txt"));
		await symlink(join(dir, "missing.txt"), join(dir, "dangling.txt"));

		const { env } = await createExecutionEnv(dir);
		const tools = createBaseTools(env);
		const read = tools.find((t) => t.name === "read");
		const write = tools.find((t) => t.name === "write");
		if (!read || !write) throw new Error("read/write missing");

		const viaLink = await read.execute("t2", { path: join(dir, "link.txt") } as never, undefined, undefined);
		expect(JSON.stringify(viaLink)).toContain("hello");

		// Dangling link: realpath fails and falls back to checking the original path; writes are not blocked
		await write.execute("t3", { path: join(dir, "dangling.txt"), content: "new" } as never, undefined, undefined);
		expect(await Bun.file(join(dir, "missing.txt")).exists()).toBe(true);
	});
});
