import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { TrustPrompt } from "../src/tui/components/dialogs/trust-prompt.ts";
import { identityStyles } from "./helpers/styles.ts";

const styles = identityStyles();

describe("TrustPrompt narrow-terminal width safety (bare-mounted in cli.ts, no WidthSafe)", () => {
	const make = (workDir: string) =>
		new TrustPrompt({ workDir, gatedMcpServers: ["materials-project", "arxiv"], onSelect: () => {} }, styles);

	test("regression: hard crash at real width <24 — every line at widths 5..30 stays ≤ the real width", () => {
		const prompt = make("/tmp/some/deeply/nested/project/directory");
		for (let width = 5; width <= 30; width += 1) {
			const lines = prompt.render(width);
			expect(lines.length, `width=${width}`).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line), `width=${width} line=${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
			}
		}
	});

	test("full content at regular widths (title/dir/gating note/two options)", () => {
		const prompt = make("/tmp/proj");
		for (const width of [40, 80, 120]) {
			const text = prompt.render(width).join("\n");
			expect(text).toContain("Trust this folder?");
			expect(text).toContain("/tmp/proj");
			expect(text).toContain("materials-project");
			expect(text).toContain("Don't trust");
		}
	});
});
