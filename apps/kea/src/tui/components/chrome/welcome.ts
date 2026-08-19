import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeStyles } from "../../theme.ts";

export interface WelcomeInfo {
	version: string;
	modelSpec: string;
	sessionId: string;
	cwd: string;
	mcpSummary?: string;
	noCredentials?: boolean;
}

const LOGO = ["█▄▀ █▀▀ ▄▀█", "█▀▄ ██▄ █▀█"] as const;

export class WelcomeComponent implements Component {
	constructor(
		readonly info: WelcomeInfo,
		readonly styles: ThemeStyles,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(0, width);
		const { styles, info } = this;

		if (safeWidth < 24) {
			const title = styles.primary(styles.bold("Welcome to Kea!"));
			const prompt = styles.dim("Type a message to start · /help for commands");
			const narrow = ["", title, prompt, `Model: ${info.modelSpec}`];
			if (info.noCredentials === true) narrow.push(styles.warning("No credentials — run /provider to get started."));
			return narrow.map((line) => truncateToWidth(line, safeWidth, "…"));
		}

		// In-box usable width = terminal width - side borders - side padding.
		const innerWidth = Math.max(1, safeWidth - 4);
		const blankInner = " ".repeat(innerWidth);
		const pad = "  ";
		const logoWidth = Math.max(...LOGO.map((row) => visibleWidth(row)));
		const gap = "  ";
		const textWidth = Math.max(4, innerWidth - logoWidth - gap.length);

		const rightRow0 = truncateToWidth(styles.primary(styles.bold("Welcome to Kea!")), textWidth, "…");
		const rightRow1 = truncateToWidth(styles.dim("Scientific discovery harness · /help for commands"), textWidth, "…");
		const headerLines = [
			`${styles.primary((LOGO[0] ?? "").padEnd(logoWidth))}${gap}${rightRow0}`,
			`${styles.primary((LOGO[1] ?? "").padEnd(logoWidth))}${gap}${rightRow1}`,
		];

		const label = (s: string) => styles.dim(styles.bold(s));
		const infoLines = [
			`${label("Directory: ")}${info.cwd}`,
			`${label("Session:   ")}${info.sessionId.slice(0, 8)}`,
			`${label("Model:     ")}${info.modelSpec}`,
		];
		if (info.noCredentials === true) infoLines.push(styles.warning("No credentials — run /provider to get started."));
		infoLines.push(`${label("Version:   ")}${info.version}`);
		if (info.mcpSummary) infoLines.push(`${label("MCP:       ")}${info.mcpSummary}`);

		const contentLines = [...headerLines, "", ...infoLines];
		const blankLine = `${styles.primary("│")}${pad}${blankInner.slice(pad.length)}${pad}${styles.primary("│")}`;
		const lines: string[] = ["", styles.primary(`╭${"─".repeat(safeWidth - 2)}╮`), blankLine];
		for (const content of contentLines) {
			const truncated = truncateToWidth(content, innerWidth - pad.length, "…");
			const rightPad = Math.max(0, innerWidth - pad.length - visibleWidth(truncated));
			lines.push(`${styles.primary("│")}${pad}${truncated}${" ".repeat(rightPad)}${pad}${styles.primary("│")}`);
		}
		lines.push(blankLine);
		lines.push(styles.primary(`╰${"─".repeat(safeWidth - 2)}╯`));
		lines.push("");
		return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
	}
}
