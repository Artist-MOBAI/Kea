import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, Transport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import {
	buildMcpToolName,
	buildWrappedMcpTools,
	formatMcpToolText,
	listAllTools,
	loadMcpConfig,
	MCP_MAX_OUTPUT_CHARS,
	McpBridge,
	type McpBridgeStatus,
	type McpServerConfig,
	resolveMcpAuthHeaders,
	sanitizeMcpName,
} from "../src/mcp.ts";

let dir: string;

afterAll(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

describe("MCP config (M2)", () => {
	test("absent file → empty config; valid stdio/url servers parse", async () => {
		dir = await mkdtemp(join(tmpdir(), "kea2-mcp-"));
		expect(await loadMcpConfig(dir, { includeProject: true })).toEqual({});

		await Bun.write(
			join(dir, ".kea", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					mp: { command: "mpmcp", env: { MP_API_KEY: "k" } },
					remote: { url: "https://example.com/mcp" },
				},
			}),
		);
		const cfg = await loadMcpConfig(dir, { includeProject: true });
		expect(Object.keys(cfg.mcpServers ?? {})).toEqual(["mp", "remote"]);
	});

	test("fail-closed default: project config loads only with explicit includeProject: true", async () => {
		dir = await mkdtemp(join(tmpdir(), "kea2-mcp-"));
		await Bun.write(join(dir, ".kea", "mcp.json"), JSON.stringify({ mcpServers: { mp: { command: "mpmcp" } } }));
		expect(await loadMcpConfig(dir)).toEqual({});
		expect(await loadMcpConfig(dir, { includeProject: false })).toEqual({});
		expect(Object.keys((await loadMcpConfig(dir, { includeProject: true })).mcpServers ?? {})).toEqual(["mp"]);
	});

	test("per-entry: a single invalid entry is skipped with a logged error, valid entries survive", async () => {
		dir = await mkdtemp(join(tmpdir(), "kea2-mcp-"));
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await Bun.write(
				join(dir, ".kea", "mcp.json"),
				JSON.stringify({ mcpServers: { bad: { nope: true }, good: { command: "mpmcp" } } }),
			);
			const cfg = await loadMcpConfig(dir, { includeProject: true });
			expect(Object.keys(cfg.mcpServers ?? {})).toEqual(["good"]);
			expect(errSpy).toHaveBeenCalled();
		} finally {
			errSpy.mockRestore();
		}
	});

	test("all entries invalid → empty mcpServers (no throw, error logged)", async () => {
		dir = await mkdtemp(join(tmpdir(), "kea2-mcp-"));
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await Bun.write(join(dir, ".kea", "mcp.json"), JSON.stringify({ mcpServers: { bad: { nope: true } } }));
			expect(await loadMcpConfig(dir, { includeProject: true })).toEqual({ mcpServers: {} });
			expect(errSpy).toHaveBeenCalled();
		} finally {
			errSpy.mockRestore();
		}
	});

	test("url server accepts only http/https schemes (file:// etc. rejected)", async () => {
		dir = await mkdtemp(join(tmpdir(), "kea2-mcp-"));
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await Bun.write(
				join(dir, ".kea", "mcp.json"),
				JSON.stringify({
					mcpServers: {
						bad: { url: "file:///etc/passwd" },
						good: { url: "https://example.com/mcp" },
					},
				}),
			);
			// bad scheme is skipped per-entry, not silently dropping the whole file
			expect(Object.keys((await loadMcpConfig(dir, { includeProject: true })).mcpServers ?? {})).toEqual(["good"]);
			expect(errSpy).toHaveBeenCalled();

			await Bun.write(
				join(dir, ".kea", "mcp.json"),
				JSON.stringify({ mcpServers: { good: { url: "http://example.com/mcp" } } }),
			);
			expect(Object.keys((await loadMcpConfig(dir, { includeProject: true })).mcpServers ?? {})).toEqual(["good"]);
		} finally {
			errSpy.mockRestore();
		}
	});

	test("connecting to a failing server records status without throwing", async () => {
		const bridge = new McpBridge();
		await bridge.connectAll({ mcpServers: { broken: { command: "/nonexistent-binary-xyz" } } });
		const statuses = bridge.getStatuses();
		expect(statuses).toHaveLength(1);
		expect(statuses[0]).toMatchObject({ server: "broken", connected: false, tools: 0 });
		expect(statuses[0]?.error).toBeTruthy();
		await bridge.close();
	}, 15_000);
});

describe("startup timeout (connectTimeoutMs injection seam + post-timeout cleanup)", () => {
	type ConnectResult = { client: Client; transport: Transport };
	/** Stub out bridge's connect (TS private is compile-time only; at runtime an OwnProperty assignment overrides the prototype method) */
	const stubConnect = (bridge: McpBridge, impl: (name: string, cfg: McpServerConfig) => Promise<ConnectResult>) => {
		(bridge as unknown as { connect: typeof impl }).connect = impl;
	};

	test("hangy connect: status records connected:false with a timeout error within the window", async () => {
		const bridge = new McpBridge({ connectTimeoutMs: 50 });
		stubConnect(bridge, () => new Promise<ConnectResult>(() => {}));
		await bridge.connectAll({ mcpServers: { hangy: { command: "whatever" } } });
		const status = bridge.getStatuses()[0];
		expect(status).toMatchObject({ server: "hangy", connected: false, tools: 0 });
		expect(status?.error).toContain("timed out");
		await bridge.close();
	});

	test("late success: a connection resolving after the timeout is closed (connectOne work.then cleanup)", async () => {
		const bridge = new McpBridge({ connectTimeoutMs: 50 });
		let closeCalls = 0;
		const lateClient = {
			close: async () => {
				closeCalls++;
			},
			listTools: async () => ({ tools: [] }),
		} as unknown as Client;
		const lateTransport = { close: async () => {} } as unknown as Transport;
		let resolveConnect!: (v: ConnectResult) => void;
		stubConnect(
			bridge,
			() =>
				new Promise<ConnectResult>((resolve) => {
					resolveConnect = resolve;
				}),
		);
		await bridge.connectAll({ mcpServers: { late: { command: "whatever" } } });
		expect(bridge.getStatuses()[0]).toMatchObject({ server: "late", connected: false, tools: 0 });
		// resolve connect only after the timeout already settled → the work.then(...) hooked in catch closes the late client
		resolveConnect({ client: lateClient, transport: lateTransport });
		await vi.waitFor(() => expect(closeCalls).toBe(1), { timeout: 2_000 });
		await bridge.close();
	});

	test("regression: the real stdio fast-fail path is unaffected by the timeout option", async () => {
		const bridge = new McpBridge({ connectTimeoutMs: 5_000 });
		await bridge.connectAll({ mcpServers: { broken: { command: "/nonexistent-binary-xyz" } } });
		const status = bridge.getStatuses()[0];
		expect(status).toMatchObject({ server: "broken", connected: false, tools: 0 });
		expect(status?.error).toBeTruthy();
		await bridge.close();
	}, 15_000);
});

describe("closing the transport when connect() fails (P1-1: stdio/streamable handles must not leak)", () => {
	test("client.connect throws → the created transport.close is called, error recorded in status", async () => {
		const closed: string[] = [];
		class FakeTransport {
			async start(): Promise<void> {
				throw new Error("connect boom");
			}
			async send(): Promise<void> {}
			async close(): Promise<void> {
				closed.push("closed");
			}
		}
		class TestBridge extends McpBridge {
			protected override createTransport(_config: McpServerConfig): Promise<Transport> {
				return Promise.resolve(new FakeTransport() as unknown as Transport);
			}
		}
		const bridge = new TestBridge();
		await bridge.connectAll({ mcpServers: { leaky: { command: "whatever" } } });
		const status = bridge.getStatuses()[0];
		expect(status).toMatchObject({ server: "leaky", connected: false, tools: 0 });
		expect(status?.error).toContain("connect boom");
		expect(closed).toEqual(["closed"]);
		await bridge.close();
	});
});

describe("tools/list single call (M1: the 2026 SDK auto-aggregates pagination in bare listTools())", () => {
	test("listAllTools sends exactly one bare call (no cursor); pagination aggregation is left to the SDK", async () => {
		const calls: unknown[][] = [];
		const client = {
			listTools: async (...args: unknown[]) => {
				calls.push(args);
				return {
					tools: [
						{ name: "a", description: "tool a", inputSchema: { type: "object" } },
						{ name: "b", inputSchema: { type: "object" } },
					],
				};
			},
		} as unknown as Client;

		const tools = await listAllTools(client);
		expect(calls.length).toBe(1);
		expect(calls[0]?.length).toBe(0);
		expect(tools).toEqual([
			{ name: "a", description: "tool a", inputSchema: { type: "object" } },
			{ name: "b", description: undefined, inputSchema: { type: "object" } },
		]);
	});
});

describe("MCP tool naming (kimi pattern: sanitize + 64-char truncation + deterministic hash)", () => {
	test("sanitize: non-alphanumeric runs fold into a single underscore", () => {
		expect(sanitizeMcpName("my..server//x")).toBe("my_server_x");
		expect(sanitizeMcpName("a b\tc")).toBe("a_b_c");
		expect(sanitizeMcpName("ok-Name_1")).toBe("ok-Name_1");
	});

	test("combined names ≤64 pass through; longer ones truncate with an 8-char deterministic hash suffix", () => {
		expect(buildMcpToolName("srv", "short")).toBe("mcp__srv__short");
		const longTool = "t".repeat(80);
		const a = buildMcpToolName("srv", longTool);
		expect(a).toBe(buildMcpToolName("srv", longTool)); // deterministic
		expect(a.length).toBe(64);
		expect(a).toMatch(/_[0-9a-f]{8}$/);
		expect(buildMcpToolName("srv2", longTool)).not.toBe(a); // different input → different suffix
	});
});

describe("MCP tool registration (duplicate dispatch and signal forwarding)", () => {
	test("sanitize duplicates: first registrant wins, conflict logged in status; closure binds its server", async () => {
		const calls: Array<{ target: string; signal?: AbortSignal; resetTimeoutOnProgress?: boolean }> = [];
		const mkClient = (tag: string) =>
			({
				callTool: async (
					params: { name: string },
					options?: { signal?: AbortSignal; resetTimeoutOnProgress?: boolean },
				) => {
					calls.push({
						target: `${tag}:${params.name}`,
						signal: options?.signal,
						resetTimeoutOnProgress: options?.resetTimeoutOnProgress,
					});
					return { content: [{ type: "text", text: tag }] };
				},
			}) as unknown as Client;

		// "a.b" and "a_b" collide after sanitize → tool name conflict
		const statuses: McpBridgeStatus[] = [
			{ server: "a.b", connected: true, tools: 1 },
			{ server: "a_b", connected: true, tools: 1 },
		];
		const tools = buildWrappedMcpTools(
			[
				{ name: "a.b", client: mkClient("first"), tools: [{ name: "search" }] },
				{ name: "a_b", client: mkClient("second"), tools: [{ name: "search" }] },
			],
			statuses,
		);

		expect(tools).toHaveLength(1);
		expect(tools[0]?.name).toBe("mcp__a_b__search");
		expect(statuses[1]?.notes?.join(" ")).toContain("duplicates");

		const controller = new AbortController();
		const result = await tools[0]?.execute("id", { q: 1 } as never, controller.signal, undefined);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.target).toBe("first:search");
		expect(calls[0]?.signal).toBe(controller.signal);
		expect(calls[0]?.resetTimeoutOnProgress).toBe(true);
		expect(((result?.content?.[0] ?? {}) as { text?: string }).text).toBe("first");
	});
});

describe("MCP tool output flattening (C1: kimi output.ts alignment)", () => {
	test("long text is truncated at the 50k budget with a truncation marker", () => {
		const out = formatMcpToolText([{ type: "text", text: "x".repeat(60_000) }]);
		expect(out.length).toBe(MCP_MAX_OUTPUT_CHARS + "\n… [MCP output truncated at 50000 characters]".length);
		expect(out.startsWith("x".repeat(1_000))).toBe(true);
		expect(out.endsWith("… [MCP output truncated at 50000 characters]")).toBe(true);
	});

	test("exactly at budget is not truncated; an empty content array stays (empty result)", () => {
		expect(formatMcpToolText([{ type: "text", text: "y".repeat(MCP_MAX_OUTPUT_CHARS) }])).toBe(
			"y".repeat(MCP_MAX_OUTPUT_CHARS),
		);
		expect(formatMcpToolText([])).toBe("(empty result)");
		expect(formatMcpToolText([{ type: "text", text: "" }])).toBe("(empty result)");
	});

	test("non-text blocks emit placeholder lines (worded per block type) instead of silent drops", () => {
		const out = formatMcpToolText([
			{ type: "text", text: "result:" },
			{ type: "image", data: "zzz" },
			{ type: "audio", data: "zzz" },
			{ type: "resource", resource: {} },
		] as ReadonlyArray<{ type: string; text?: string }>);
		expect(out).toContain("result:");
		expect(out).toContain("[omitted image content from MCP server]");
		expect(out).toContain("[omitted audio content from MCP server]");
		expect(out).toContain("[omitted resource content from MCP server]");
	});

	test("pure placeholders (no text blocks) do not misreport empty", () => {
		const out = formatMcpToolText([{ type: "image", data: "zzz" }] as unknown as ReadonlyArray<{ type: string }>);
		expect(out).toBe("[omitted image content from MCP server]");
	});

	test("placeholders stay out of the truncation budget: with text at budget, the placeholder survives", () => {
		const out = formatMcpToolText([
			{ type: "text", text: "x".repeat(MCP_MAX_OUTPUT_CHARS + 500) },
			{ type: "image", data: "zzz" },
		] as ReadonlyArray<{ type: string; text?: string }>);
		expect(out).toContain("[omitted image content from MCP server]");
		expect(out).toContain("… [MCP output truncated at 50000 characters]");
	});

	test("wrapped tools share the same formatting: mixed content blocks + isError passthrough unchanged", async () => {
		const client = {
			callTool: async () => ({
				content: [
					{ type: "text", text: "partial" },
					{ type: "image", data: "zzz" },
				],
				isError: true,
			}),
		} as unknown as Client;
		const tools = buildWrappedMcpTools(
			[{ name: "srv", client, tools: [{ name: "lookup" }] }],
			[{ server: "srv", connected: true, tools: 1 }],
		);
		const result = await tools[0]?.execute("id", {}, undefined, undefined);
		const text = ((result?.content?.[0] ?? {}) as { text?: string }).text ?? "";
		expect(text).toContain("partial");
		expect(text).toContain("[omitted image content from MCP server]");
		expect((result as { isError?: boolean } | undefined)?.isError).toBe(true);
	});
});

describe("MCP config schema: transport and bearerTokenEnvVar (C2)", () => {
	test("explicit transport sse / streamable-http / stdio declarations and bearerTokenEnvVar all parse", async () => {
		dir = await mkdtemp(join(tmpdir(), "kea2-mcp-"));
		await Bun.write(
			join(dir, ".kea", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					sse: { url: "https://example.com/sse", transport: "sse", bearerTokenEnvVar: "KEA_TOKEN" },
					http: { url: "https://example.com/mcp", transport: "streamable-http" },
					legacy: { url: "https://example.com/mcp" }, // no transport = streamable-http (existing default)
					local: { command: "mpmcp", transport: "stdio" },
				},
			}),
		);
		const cfg = await loadMcpConfig(dir, { includeProject: true });
		expect(Object.keys(cfg.mcpServers ?? {})).toEqual(["sse", "http", "legacy", "local"]);
		expect(cfg.mcpServers?.sse).toMatchObject({ transport: "sse", bearerTokenEnvVar: "KEA_TOKEN" });
	});

	test("invalid transport enum values are skipped per entry with an error log (whole file not dropped)", async () => {
		dir = await mkdtemp(join(tmpdir(), "kea2-mcp-"));
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await Bun.write(
				join(dir, ".kea", "mcp.json"),
				JSON.stringify({
					mcpServers: {
						bad: { url: "https://example.com/mcp", transport: "websocket" },
						good: { url: "https://example.com/mcp" },
					},
				}),
			);
			const cfg = await loadMcpConfig(dir, { includeProject: true });
			expect(Object.keys(cfg.mcpServers ?? {})).toEqual(["good"]);
			expect(errSpy).toHaveBeenCalled();
		} finally {
			errSpy.mockRestore();
		}
	});
});

describe("MCP bearer auth and SSE transport (C2)", () => {
	const TOKEN_VAR = "KEA_TEST_BEARER_TOKEN";

	afterEach(() => {
		delete process.env[TOKEN_VAR];
	});

	test("resolveMcpAuthHeaders: env set → Authorization merges into headers; custom headers preserved", () => {
		process.env[TOKEN_VAR] = "secret-token";
		expect(resolveMcpAuthHeaders({ bearerTokenEnvVar: TOKEN_VAR })).toEqual({
			Authorization: "Bearer secret-token",
		});
		expect(resolveMcpAuthHeaders({ headers: { "X-Custom": "1" }, bearerTokenEnvVar: TOKEN_VAR })).toEqual({
			"X-Custom": "1",
			Authorization: "Bearer secret-token",
		});
		expect(resolveMcpAuthHeaders({ headers: { "X-Custom": "1" } })).toEqual({ "X-Custom": "1" });
	});

	test("resolveMcpAuthHeaders: missing env → throws naming the variable (isolated per-server failure)", () => {
		delete process.env[TOKEN_VAR];
		expect(() => resolveMcpAuthHeaders({ bearerTokenEnvVar: TOKEN_VAR })).toThrow(TOKEN_VAR);
	});

	test("bearerTokenEnvVar missing env: the server is marked failed, status says which variable", async () => {
		delete process.env[TOKEN_VAR];
		const bridge = new McpBridge();
		await bridge.connectAll({
			mcpServers: { gated: { url: "https://example.com/mcp", bearerTokenEnvVar: TOKEN_VAR } },
		});
		const status = bridge.getStatuses()[0];
		expect(status).toMatchObject({ server: "gated", connected: false, tools: 0 });
		expect(status?.error).toContain(TOKEN_VAR);
		await bridge.close();
	}, 15_000);

	test("transport: sse → SSEClientTransport; default or streamable-http → StreamableHTTPClientTransport", async () => {
		const { SSEClientTransport, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
		const bridge = new McpBridge();
		const create = (cfg: McpServerConfig) =>
			(bridge as unknown as { createTransport(config: McpServerConfig): Promise<Transport> }).createTransport(cfg);
		// constructing a transport performs no I/O (connection starts at client.connect), so this stays offline
		expect(await create({ url: "https://example.com/sse", transport: "sse" })).toBeInstanceOf(SSEClientTransport);
		expect(await create({ url: "https://example.com/mcp" })).toBeInstanceOf(StreamableHTTPClientTransport);
		expect(await create({ url: "https://example.com/mcp", transport: "streamable-http" })).toBeInstanceOf(
			StreamableHTTPClientTransport,
		);
		await bridge.close();
	});
});
