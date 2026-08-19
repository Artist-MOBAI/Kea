import { mkdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ConfigValue = string | number | boolean;
export type FlatConfig = Record<string, ConfigValue>;

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".kea", "kea.toml");
}

export function userConfigDir(): string {
	// same KEA_HOME override surface as core's trust/auth ledgers
	return join(process.env.KEA_HOME ?? homedir(), ".kea");
}

// parse must stay symmetric with serializeFlatToml's JSON.stringify: quoted values scan to the
// unescaped closing quote (the rest of the line is dropped), unquoted values strip `#` comments
function parseValue(raw: string): ConfigValue {
	if (raw.startsWith('"')) {
		for (let i = 1; i < raw.length; i++) {
			if (raw[i] === "\\") {
				i++;
				continue;
			}
			if (raw[i] === '"') {
				const literal = raw.slice(0, i + 1);
				try {
					return JSON.parse(literal) as string;
				} catch {
					return literal.slice(1, -1);
				}
			}
		}
		return raw; // unclosed quote: keep the malformed line verbatim
	}
	const hash = raw.indexOf("#");
	const value = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
	if (value === "true" || value === "false") return value === "true";
	if (value !== "" && Number.isFinite(Number(value))) return Number(value);
	return value;
}

function parseFlatToml(text: string): FlatConfig {
	const out: FlatConfig = {};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#") || line.startsWith("[")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		out[key] = parseValue(line.slice(eq + 1).trim());
	}
	return out;
}

function serializeFlatToml(config: FlatConfig): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(config)) {
		if (typeof value === "string") lines.push(`${key} = ${JSON.stringify(value)}`);
		else lines.push(`${key} = ${value}`);
	}
	return `${lines.join("\n")}\n`;
}

export async function loadConfig(path: string): Promise<FlatConfig> {
	const file = Bun.file(path);
	if (!(await file.exists())) return {};
	try {
		return parseFlatToml(await file.text());
	} catch {
		return {};
	}
}

function hasClosedQuote(value: string): boolean {
	for (let i = 1; i < value.length; i++) {
		const ch = value.charAt(i);
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === '"') return true;
	}
	return false;
}

// loadConfig is fail-open, but saveConfig must not rewrite a file whose lines parsing would silently
// drop (parse skips garbage → the rewrite persists the loss); corrupted files are left for manual repair.
// Structured TOML (section headers, array values) is flat-writer-unsupported: rewriting would drop the
// headers and mangle the arrays — refuse and name the file instead of silently clobbering.
function assertFlatTomlWritable(text: string, path: string): void {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (line === "" || line.startsWith("#")) continue;
		if (line.startsWith("[")) {
			throw new Error(
				`${path} contains a TOML table header ("${line}") that the flat config writer would drop — edit the file manually instead`,
			);
		}
		const eq = line.indexOf("=");
		if (eq <= 0) {
			throw new Error(
				`${path} is corrupted (line ${i + 1} is not a "key = value" entry: "${line}"); fix or remove the file manually — refusing to overwrite it`,
			);
		}
		const value = line.slice(eq + 1).trim();
		if (value.startsWith("[")) {
			throw new Error(
				`${path} contains an array value ("${line}") that the flat config writer would mangle — edit the file manually instead`,
			);
		}
		if (value.startsWith('"') && !hasClosedQuote(value)) {
			throw new Error(
				`${path} is corrupted (line ${i + 1} has an unclosed quote: "${line}"); fix or remove the file manually — refusing to overwrite it`,
			);
		}
	}
}

export async function saveConfig(path: string, config: FlatConfig): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const file = Bun.file(path);
	let existing: FlatConfig = {};
	if (await file.exists()) {
		const text = await file.text();
		assertFlatTomlWritable(text, path);
		existing = parseFlatToml(text);
	}
	const merged = { ...existing, ...config };
	// Atomic write: same-directory tmp + rename, so a crash mid-write never truncates the config
	const tmpPath = `${path}.tmp-${Math.random().toString(36).slice(2)}`;
	await Bun.write(tmpPath, serializeFlatToml(merged));
	try {
		await rename(tmpPath, path);
	} catch (err) {
		await unlink(tmpPath).catch(() => {});
		throw err;
	}
}
