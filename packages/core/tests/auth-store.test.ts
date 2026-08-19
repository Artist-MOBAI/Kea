import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { authStorePath, FileCredentialStore } from "../src/auth-store.ts";

let home: string;
let prevHome: string | undefined;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "kea2-auth-store-"));
	prevHome = process.env.KEA_HOME;
	process.env.KEA_HOME = home;
});

afterEach(async () => {
	if (prevHome === undefined) delete process.env.KEA_HOME;
	else process.env.KEA_HOME = prevHome;
	await rm(home, { recursive: true, force: true });
});

describe("FileCredentialStore (pi CredentialStore implementation)", () => {
	test("write/read/list/delete round-trip", async () => {
		const store = new FileCredentialStore();
		expect(await store.read("mylab")).toBeUndefined();
		expect(await store.list()).toEqual([]);

		const cred = { type: "api_key", key: "sk-test-123" } as const;
		await expect(store.modify("mylab", async () => cred)).resolves.toEqual(cred);
		expect(await store.read("mylab")).toEqual(cred);
		// list returns metadata only (the key never leaks)
		expect(await store.list()).toEqual([{ providerId: "mylab", type: "api_key" }]);

		await store.modify("other", async () => ({ type: "api_key", key: "sk-2" }));
		expect((await store.list()).map((c) => c.providerId).sort()).toEqual(["mylab", "other"]);

		await store.delete("mylab");
		expect(await store.read("mylab")).toBeUndefined();
		expect(await store.list()).toEqual([{ providerId: "other", type: "api_key" }]);
	});

	test("file 0600, directory 0700", async () => {
		const store = new FileCredentialStore();
		await store.modify("p", async () => ({ type: "api_key", key: "k" }));
		expect((await stat(authStorePath())).mode & 0o777).toBe(0o600);
		expect((await stat(join(home, ".kea"))).mode & 0o777).toBe(0o700);
	});

	test("malformed JSON → fail-closed as empty ledger + at most one warn", async () => {
		await Bun.write(authStorePath(), "{ broken");
		const store = new FileCredentialStore();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(await store.read("mylab")).toBeUndefined();
			expect(await store.list()).toEqual([]);
			expect(warn).toHaveBeenCalledTimes(1);
			// Repeated reads do not warn again (normal path is silent)
			await store.read("mylab");
			await store.list();
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	test("schema violation (valid JSON) → also fail-closed + warn", async () => {
		await mkdir(join(home, ".kea"), { recursive: true });
		await Bun.write(authStorePath(), JSON.stringify({ prov: { type: "carrier-pigeon" } }));
		const store = new FileCredentialStore();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(await store.read("prov")).toBeUndefined();
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	test("poisoned ledger (exists but invalid JSON): modify/delete refuse, file untouched, chain unbroken", async () => {
		await mkdir(join(home, ".kea"), { recursive: true });
		const poison = "{ broken";
		await Bun.write(authStorePath(), poison);
		const store = new FileCredentialStore();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(store.modify("mylab", async () => ({ type: "api_key", key: "sk-x" }))).rejects.toThrow(
				/refusing to rewrite malformed credential ledger .*auth\.json/,
			);
			await expect(store.delete("mylab")).rejects.toThrow(/fix or remove the file manually/);
			// the poisoned file is never rewritten from the empty fallback base
			expect(await Bun.file(authStorePath()).text()).toBe(poison);
			// manual fix unblocks writes and the pre-existing valid key survives
			await Bun.write(authStorePath(), JSON.stringify({ other: { type: "api_key", key: "k" } }));
			await store.modify("mylab", async () => ({ type: "api_key", key: "sk-ok" }));
			expect(await store.read("mylab")).toEqual({ type: "api_key", key: "sk-ok" });
			expect(await store.read("other")).toEqual({ type: "api_key", key: "k" });
		} finally {
			warn.mockRestore();
		}
	});

	test("poisoned ledger (schema violation): modify also refuses, file stays untouched", async () => {
		await mkdir(join(home, ".kea"), { recursive: true });
		const poison = JSON.stringify({ prov: { type: "carrier-pigeon" } });
		await Bun.write(authStorePath(), poison);
		const store = new FileCredentialStore();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(store.modify("prov", async () => ({ type: "api_key", key: "k" }))).rejects.toThrow(
				/refusing to rewrite malformed credential ledger/,
			);
			expect(await Bun.file(authStorePath()).text()).toBe(poison);
		} finally {
			warn.mockRestore();
		}
	});

	test("rejects OAuth credentials; a failed modify does not break the chain", async () => {
		const store = new FileCredentialStore();
		await expect(
			store.modify("anthropic", async () => ({ type: "oauth", refresh: "r", access: "a", expires: 0 })),
		).rejects.toThrow(/API-key credentials only/);
		expect(await store.read("anthropic")).toBeUndefined();

		// The chain is unbroken: a subsequent modify persists normally
		await store.modify("anthropic", async () => ({ type: "api_key", key: "sk-ok" }));
		expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-ok" });
	});

	test("concurrent modify serializes: no lost writes", async () => {
		const store = new FileCredentialStore();
		const total = 25;
		const increment = async (cur: Credential | undefined): Promise<Credential> => {
			const prev = cur?.type === "api_key" ? Number(cur.key ?? "0") : 0;
			return { type: "api_key", key: String(prev + 1) };
		};
		await Promise.all(Array.from({ length: total }, () => store.modify("counter", increment)));
		const final = await store.read("counter");
		expect(final).toEqual({ type: "api_key", key: String(total) });
	});

	test("cross-instance concurrent modify (module-level chain): no lost writes", async () => {
		// kernel/cli/doctor/overlays each new a FileCredentialStore(): the chain must be shared process-wide
		const a = new FileCredentialStore();
		const b = new FileCredentialStore();
		const total = 24;
		const increment = async (cur: Credential | undefined): Promise<Credential> => {
			const prev = cur?.type === "api_key" ? Number(cur.key ?? "0") : 0;
			return { type: "api_key", key: String(prev + 1) };
		};
		await Promise.all(Array.from({ length: total }, (_, i) => (i % 2 === 0 ? a : b).modify("counter", increment)));
		expect(await a.read("counter")).toEqual({ type: "api_key", key: String(total) });
		expect(await b.read("counter")).toEqual({ type: "api_key", key: String(total) });
	});

	test("KEA_HOME mutated mid-operation → this modify still reads/writes the path captured at start", async () => {
		const store = new FileCredentialStore();
		await store.modify("p", async () => ({ type: "api_key", key: "k1" }));
		const originalPath = authStorePath();
		const otherHome = await mkdtemp(join(tmpdir(), "kea2-auth-store-other-"));
		const savedHome = process.env.KEA_HOME;
		try {
			await store.modify("p", async () => {
				process.env.KEA_HOME = otherHome;
				return { type: "api_key", key: "k2" };
			});
			// Writes back to the original path; does not fork a second ledger in the new home
			expect(await Bun.file(originalPath).json()).toEqual({ p: { type: "api_key", key: "k2" } });
			expect(await Bun.file(join(otherHome, ".kea", "auth.json")).exists()).toBe(false);
		} finally {
			process.env.KEA_HOME = savedHome;
			await rm(otherHome, { recursive: true, force: true });
		}
	});

	test("no leftover temp files after write; final file 0600", async () => {
		const store = new FileCredentialStore();
		await store.modify("p", async () => ({ type: "api_key", key: "k" }));
		expect((await stat(authStorePath())).mode & 0o777).toBe(0o600);
		const leftovers: string[] = [];
		for await (const f of new Bun.Glob("*.tmp-*").scan(join(home, ".kea"))) leftovers.push(f);
		expect(leftovers).toEqual([]);
	});

	test("writeStore failure → modify rejects, no temp file left behind, chain unbroken", async () => {
		await Bun.write(join(home, ".kea"), "blocker"); // .kea is a plain file, so directory creation fails
		const store = new FileCredentialStore();
		await expect(store.modify("p", async () => ({ type: "api_key", key: "k" }))).rejects.toThrow();
		const leftovers: string[] = [];
		for await (const f of new Bun.Glob("**/*.tmp-*").scan(home)) leftovers.push(f);
		expect(leftovers).toEqual([]);
		// Usable again after removing the obstacle (chain unbroken)
		await rm(join(home, ".kea"));
		await store.modify("p", async () => ({ type: "api_key", key: "k2" }));
		expect(await store.read("p")).toEqual({ type: "api_key", key: "k2" });
	});

	test("modify returning undefined → keeps and settles the original value", async () => {
		const store = new FileCredentialStore();
		await store.modify("p", async () => ({ type: "api_key", key: "first" }));
		await expect(store.modify("p", async () => undefined)).resolves.toEqual({ type: "api_key", key: "first" });
		expect(await store.read("p")).toEqual({ type: "api_key", key: "first" });
	});

	test("delete of a nonexistent entry: no-op, never creates the file", async () => {
		const store = new FileCredentialStore();
		await store.delete("ghost");
		expect(await Bun.file(authStorePath()).exists()).toBe(false);
	});
});
