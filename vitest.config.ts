import { defineConfig } from "vitest/config";

// vitest 4: forks pool is the default; workers inherit process.execPath,
// so running via `bun ./node_modules/vitest/vitest.mjs run` executes on Bun (Kea-1 verified pattern).
export default defineConfig({
	test: {
		include: ["apps/*/tests/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
		environment: "node",
		testTimeout: 120_000,
		hookTimeout: 60_000,
		fileParallelism: false,
		server: {
			deps: {
				inline: ["zod"],
			},
		},
		pool: "forks",
	},
});
