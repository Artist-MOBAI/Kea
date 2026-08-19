import { basename } from "node:path";

// Sensitive file detection: .env / SSH private keys / credential files; exempt templates (.env.example etc.)
// and public keys (*.pub). Read/Write/Edit refuse access; Glob/Grep filter automatically.

const SENSITIVE_BASENAMES = new Set<string>([
	".env",
	".envrc",
	".netrc",
	"id_rsa",
	"id_dsa",
	"id_ed25519",
	"id_ecdsa",
	"credentials",
	"application_default_credentials.json",
	// Kea credential store (~/.kea/auth.json); the "credentials" prefix rule does not cover it
	"auth.json",
]);

const SENSITIVE_PATH_SUFFIXES = [
	[".aws", "credentials"],
	[".gcp", "credentials"],
];

const ENV_PREFIX = ".env.";
const ENV_EXEMPTIONS = new Set<string>([".env.example", ".env.sample", ".env.template"]);

/** auth.json write temps (auth.json.tmp-<pid>-<uuid>) and manual backups (auth.json.bak) are variants, not washable by rename */
const AUTH_JSON_PREFIX = "auth.json.";

const SENSITIVE_BASENAME_PREFIXES = ["id_rsa", "id_dsa", "id_ed25519", "id_ecdsa", "credentials"];
/** id_* families: any short extension (≤4 chars) keeps the file sensitive (id_rsa.txt); "credentials" stays on the fixed variant list (credentials.json is deliberately allowed). */
const PRIVATE_KEY_PREFIXES = new Set(["id_rsa", "id_dsa", "id_ed25519", "id_ecdsa"]);
const PUBLIC_KEY_BASENAMES = new Set<string>(["id_rsa.pub", "id_dsa.pub", "id_ed25519.pub", "id_ecdsa.pub"]);

/** Generic private-key suffixes: *.ppk (PuTTY) / *.key (matches only filenames ending in .key, e.g. signing.key; monkey.txt is unaffected) */
const SENSITIVE_KEY_SUFFIXES = [".ppk", ".key"];

const SENSITIVE_DOT_VARIANT_SUFFIXES = new Set<string>([
	".bak",
	".backup",
	".copy",
	".disabled",
	".key",
	".old",
	".orig",
	".pem",
	".save",
	".tmp",
]);

export function isSensitiveFile(path: string): boolean {
	const name = basename(path).toLowerCase();
	const comparablePath = path.toLowerCase();

	if (ENV_EXEMPTIONS.has(name)) return false;
	if (PUBLIC_KEY_BASENAMES.has(name)) return false;
	if (SENSITIVE_BASENAMES.has(name)) return true;
	if (name.startsWith(ENV_PREFIX)) return true;
	if (name.startsWith(AUTH_JSON_PREFIX)) return true;

	for (const prefix of SENSITIVE_BASENAME_PREFIXES) {
		if (name === prefix) return true;
		if (name.length > prefix.length && name.startsWith(prefix)) {
			const suffix = name.slice(prefix.length);
			const next = suffix[0];
			if (next === "-" || next === "_") return true;
			if (next === ".") {
				if (PRIVATE_KEY_PREFIXES.has(prefix) && /^\.[a-z0-9]{1,4}$/.test(suffix)) return true;
				if (SENSITIVE_DOT_VARIANT_SUFFIXES.has(suffix)) return true;
			}
		}
	}

	for (const keySuffix of SENSITIVE_KEY_SUFFIXES) {
		if (name.endsWith(keySuffix)) return true;
	}

	// GCP service-account keys: service-account.json / service-account-<id>.json
	if (name.startsWith("service-account") && name.endsWith(".json")) return true;

	for (const suffixParts of SENSITIVE_PATH_SUFFIXES) {
		const suffix = suffixParts.join("/").toLowerCase();
		if (comparablePath.endsWith(`/${suffix}`) || comparablePath.includes(`/${suffix}/`)) return true;
	}

	return false;
}
