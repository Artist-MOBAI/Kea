import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import { Client, type Transport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { MAX_TOOL_RESULT_CHARS } from "./timeouts.ts";
import { asTool } from "./tools.ts";

// Total budget for connect + listTools: timing out on either step counts as connection failure.
const CONNECT_TIMEOUT_MS = 30_000;
// Tool name length cap; truncation appends a deterministic hash suffix (no drift).
const MAX_TOOL_NAME_LEN = 64;

// Total character budget for one MCP tool call's joined text output — chatty servers must not flood the context.
export const MCP_MAX_OUTPUT_CHARS = MAX_TOOL_RESULT_CHARS;
const MCP_TRUNCATION_MARKER = `\n… [MCP output truncated at ${MAX_TOOL_RESULT_CHARS} characters]`;

const ServerConfigSchema = z.union(
	[
		z.object({
			command: z.string(),
			args: z.array(z.string()).optional(),
			env: z.record(z.string(), z.string()).optional(),
			transport: z.literal("stdio").optional(),
		}),
		z.object({
			// url accepts http/https only; localhost/IP allowed (same bar as custom model baseUrl: hand-written
			// project config in a trusted directory — SSRF risk is borne by the trust gate)
			url: z.url({ protocol: /^https?$/i }),
			headers: z.record(z.string(), z.string()).optional(),
			// remote transport: absent = streamable-http (default), "sse" = legacy HTTP+SSE transport
			transport: z.enum(["streamable-http", "sse"]).optional(),
			// env var name holding a bearer token; read at connect time, a missing var fails this server only
			bearerTokenEnvVar: z.string().min(1).optional(),
		}),
	],
	{
		error:
			'server entry must be stdio ({ command, args?, env?, transport?: "stdio" }) or remote ({ url, headers?, transport?: "sse" | "streamable-http", bearerTokenEnvVar? })',
	},
);

const McpConfigSchema = z.object({
	mcpServers: z.record(z.string(), ServerConfigSchema).optional(),
});

export type McpServerConfig = z.infer<typeof ServerConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;

export interface McpBridgeStatus {
	server: string;
	connected: boolean;
	tools: number;
	error?: string;
	// non-fatal notes (e.g. name collisions), shown by /doctor and the status panel
	notes?: string[];
}

export interface McpListedTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface McpServerHandle {
	name: string;
	client: Client;
	tools: McpListedTool[];
}

export function mcpConfigPath(cwd: string): string {
	return join(cwd, ".kea", "mcp.json");
}

// Merge configured headers with a bearer Authorization header read from the environment at connect time.
// A missing env var throws naming the variable: the failure propagates into connectOne's per-server catch,
// so only that server is marked failed and the status says which variable is absent.
export function resolveMcpAuthHeaders(config: {
	headers?: Record<string, string>;
	bearerTokenEnvVar?: string;
}): Record<string, string> {
	const headers = { ...(config.headers ?? {}) };
	if (config.bearerTokenEnvVar !== undefined) {
		const token = process.env[config.bearerTokenEnvVar];
		if (!token) {
			throw new Error(`bearerTokenEnvVar "${config.bearerTokenEnvVar}" is not set in the environment`);
		}
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

// Flatten MCP tool result content blocks into model-visible text:
// - text blocks join with "\n" under the 50k character budget; overflow slices and appends a truncation marker;
// - non-text blocks (image/audio/video/resource/…) become one placeholder line each, worded by block type —
//   placeholders sit outside the truncation budget but count toward non-emptiness (an image-only result is
//   reported as such, never silently dropped into "(empty result)").
export function formatMcpToolText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
	const texts: string[] = [];
	const placeholders: string[] = [];
	for (const part of parts) {
		if (part.type === "text" && typeof part.text === "string") {
			texts.push(part.text);
		} else {
			placeholders.push(`[omitted ${part.type} content from MCP server]`);
		}
	}
	const joined = texts.join("\n");
	const body =
		joined.length > MCP_MAX_OUTPUT_CHARS ? `${joined.slice(0, MCP_MAX_OUTPUT_CHARS)}${MCP_TRUNCATION_MARKER}` : joined;
	const sections = body === "" ? [] : [body];
	if (placeholders.length > 0) sections.push(placeholders.join("\n"));
	return sections.length > 0 ? sections.join("\n") : "(empty result)";
}

export interface McpConfigLoad {
	config: McpConfig;
	/** non-fatal load problems (invalid JSON / malformed entries): the valid remainder still loads */
	errors: string[];
}

/** Detailed variant for diagnostics (/doctor): parse/validation failures surface instead of collapsing into "none configured". */
export async function loadMcpConfigDetailed(
	cwd: string,
	opts: { includeProject?: boolean } = {},
): Promise<McpConfigLoad> {
	// project-level MCP is fail-closed: only load when includeProject: true is explicitly passed;
	// the caller passes the trust state in (kernel/doctor both pass trusted); omitting it = don't load
	if (opts.includeProject !== true) return { config: {}, errors: [] };
	const path = mcpConfigPath(cwd);
	const file = Bun.file(path);
	if (!(await file.exists())) return { config: {}, errors: [] };
	const errors: string[] = [];
	let raw: unknown;
	try {
		raw = await file.json();
	} catch (err) {
		return {
			config: {},
			errors: [`ignoring ${path}: not valid JSON (${err instanceof Error ? err.message : String(err)})`],
		};
	}
	// per-entry parsing: one malformed server must not silently drop the whole file; only a non-JSON / non-object top level is fail-closed
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { config: {}, errors: [`ignoring ${path}: top-level value is not an object`] };
	}
	const mcpServers = (raw as Record<string, unknown>).mcpServers;
	if (mcpServers === undefined) return { config: {}, errors: [] };
	if (typeof mcpServers !== "object" || mcpServers === null || Array.isArray(mcpServers)) {
		return { config: {}, errors: [`ignoring ${path}: mcpServers is not an object`] };
	}
	const valid: Record<string, McpServerConfig> = {};
	for (const [name, value] of Object.entries(mcpServers as Record<string, unknown>)) {
		const parsed = ServerConfigSchema.safeParse(value);
		if (parsed.success) {
			valid[name] = parsed.data;
		} else {
			errors.push(`ignoring server "${name}" in ${path}: ${z.prettifyError(parsed.error)}`);
		}
	}
	return { config: { mcpServers: valid }, errors };
}

export async function loadMcpConfig(cwd: string, opts: { includeProject?: boolean } = {}): Promise<McpConfig> {
	const { config, errors } = await loadMcpConfigDetailed(cwd, opts);
	for (const error of errors) console.error(`[mcp] ${error}`);
	return config;
}

export function sanitizeMcpName(raw: string): string {
	return raw.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

/** FNV-1a 32-bit: deterministic 8-char hex suffix for truncated names */
function fnv1aHex8(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

export function buildMcpToolName(serverName: string, toolName: string): string {
	const full = `mcp__${sanitizeMcpName(serverName)}__${sanitizeMcpName(toolName)}`;
	if (full.length <= MAX_TOOL_NAME_LEN) return full;
	return `${full.slice(0, MAX_TOOL_NAME_LEN - 9)}_${fnv1aHex8(full)}`;
}

/** Simple promise timeout: reject on deadline; does not cancel the original promise, cleanup is the caller's job */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

// The SDK's bare listTools() (no cursor argument) auto-aggregates all pages (bounded by
// ClientOptions.listMaxPages); only passing {cursor} returns a raw single page — one call gets everything.
export async function listAllTools(client: Pick<Client, "listTools">): Promise<McpListedTool[]> {
	const page = await client.listTools();
	return page.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

export interface McpBridgeOptions {
	/** Total budget for connect + listTools (default 30s; tests can inject ~50ms to shorten) */
	connectTimeoutMs?: number;
}

export class McpBridge {
	private servers: McpServerHandle[] = [];
	private statuses: McpBridgeStatus[] = [];
	private readonly connectTimeoutMs: number;

	constructor(opts: McpBridgeOptions = {}) {
		this.connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
	}

	async connectAll(config: McpConfig): Promise<void> {
		const entries = Object.entries(config.mcpServers ?? {});
		await Promise.all(entries.map(([name, serverConfig]) => this.connectOne(name, serverConfig)));
	}

	// Atomic startup: connect + listTools wrapped in one timeout; failure on either step closes any established
	// connection (a stdio child process must not leak), status records the real error.
	private async connectOne(name: string, serverConfig: McpServerConfig): Promise<void> {
		let client: Client | undefined;
		let transport: Transport | undefined;
		const work = (async () => {
			const connected = await this.connect(name, serverConfig);
			client = connected.client;
			transport = connected.transport;
			const tools = await listAllTools(connected.client);
			return { ...connected, tools };
		})();
		try {
			const { client: c, tools } = await withTimeout(work, this.connectTimeoutMs);
			this.servers.push({ name, client: c, tools });
			this.statuses.push({ server: name, connected: true, tools: tools.length });
		} catch (err) {
			// settle then close: close client if connect succeeded, otherwise the transport may already be spawned (stdio child)
			if (client) await client.close().catch(() => {});
			else if (transport) await transport.close().catch(() => {});
			// after a timeout, work may still succeed later — close that late connection too
			work.then((w) => w.client.close().catch(() => {})).catch(() => {});
			this.statuses.push({
				server: name,
				connected: false,
				tools: 0,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async connect(name: string, config: McpServerConfig): Promise<{ client: Client; transport: Transport }> {
		const client = new Client({ name: `kea:${sanitizeMcpName(name)}`, version: "0.1.0" });
		const transport = await this.createTransport(config);
		try {
			await client.connect(transport);
		} catch (err) {
			// the transport was already spawned (stdio child process / streamable handle) and the local var never made it
			// back to connectOne's cleanup; close it here (best-effort) so a failed connect cannot leak it
			await transport.close().catch(() => {});
			throw err;
		}
		return { client, transport };
	}

	/** Transport construction seam: kept separate from connect() so tests can inject a fake transport and assert close-on-connect-failure. */
	protected createTransport(config: McpServerConfig): Promise<Transport> {
		if ("command" in config) {
			return Promise.resolve(
				new StdioClientTransport({
					command: config.command,
					args: config.args ?? [],
					env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
				}),
			);
		}
		return (async () => {
			// bearer token is read here (connect time): a missing env var throws before any transport is built,
			// so the failure is recorded per-server without touching the network
			const headers = resolveMcpAuthHeaders(config);
			const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
			const { SSEClientTransport, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
			if (config.transport === "sse") {
				return new SSEClientTransport(new URL(config.url), { requestInit });
			}
			return new StreamableHTTPClientTransport(new URL(config.url), { requestInit });
		})();
	}

	async wrappedTools(): Promise<AgentTool[]> {
		return buildWrappedMcpTools(this.servers, this.statuses);
	}

	getStatuses(): McpBridgeStatus[] {
		return [...this.statuses];
	}

	async close(): Promise<void> {
		await Promise.allSettled(this.servers.map((s) => s.client.close()));
		this.servers = [];
	}
}

// Register connected servers' tools as agent tools. Names are sanitized + truncated to 64 chars (deterministic
// hash suffix); on post-sanitize name collisions, first registrant wins (duplicates skipped, conflict note on
// the matching status). execute closures bind their own client/original tool name, so the wrong server is never hit.
export function buildWrappedMcpTools(servers: readonly McpServerHandle[], statuses: McpBridgeStatus[]): AgentTool[] {
	const tools: AgentTool[] = [];
	const owners = new Map<string, string>(); // final tool name -> first-registered server
	for (const server of servers) {
		const status = statuses.find((s) => s.server === server.name);
		for (const tool of server.tools) {
			const name = buildMcpToolName(server.name, tool.name);
			const owner = owners.get(name);
			if (owner !== undefined) {
				if (status) {
					status.notes ??= [];
					status.notes.push(`tool "${name}" duplicates server "${owner}" registration; skipped`);
				}
				continue;
			}
			owners.set(name, server.name);
			const schema = (tool.inputSchema ?? { type: "object" }) as TSchema;
			const client = server.client;
			const originalName = tool.name;
			const serverName = server.name;
			tools.push(
				asTool({
					name,
					label: name,
					description: tool.description ?? `MCP tool ${originalName} (${serverName})`,
					parameters: schema,
					executionMode: "sequential",
					async execute(_id: string, params: Record<string, unknown> | undefined, signal?: AbortSignal) {
						// pass the agent signal through into SDK request options; leave timeout at SDK default
						const result = await client.callTool(
							{ name: originalName, arguments: params ?? {} },
							{ signal, resetTimeoutOnProgress: true, onprogress: () => {} },
						);
						const parts = (result.content as Array<{ type: string; text?: string }>) ?? [];
						return {
							content: [{ type: "text", text: formatMcpToolText(parts) }],
							details: { server: serverName, tool: originalName },
							// MCP passthrough deliberately keeps isError: kernel handles MCP errors via the afterToolCall hook
							isError: result.isError === true,
						};
					},
				}),
			);
		}
	}
	return tools;
}
