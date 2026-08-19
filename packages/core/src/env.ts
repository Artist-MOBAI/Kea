import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

// Native shell, no OS sandbox: safety relies on approval + execpolicy + the workspace trust gate.
// shellPath honors the user's login shell ($SHELL) — pi's fixed /bin/bash drops a zsh user's PATH configuration;
// an empty/unset SHELL falls back to pi's own resolution. shellEnv applies NO_COLOR/TERM=dumb (keep ANSI escapes
// and pagers out of captured output) and GIT_TERMINAL_PROMPT=0 — unconditionally, so a user preset of 1 cannot
// re-enable interactive git hangs (git fails fast instead of waiting on a prompt).
export function createExecutionEnv(cwd: string): { env: NodeExecutionEnv } {
	const shell = process.env.SHELL?.trim();
	return {
		env: new NodeExecutionEnv({
			cwd,
			shellPath: shell && shell !== "" ? shell : undefined,
			shellEnv: {
				NO_COLOR: "1",
				TERM: "dumb",
				GIT_TERMINAL_PROMPT: "0",
			},
		}),
	};
}
