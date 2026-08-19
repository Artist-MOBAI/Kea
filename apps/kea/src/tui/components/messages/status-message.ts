import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeStyles } from "../../theme.ts";
import { WidthCache } from "./render-cache.ts";

export class StatusMessage implements Component {
	private readonly textComponent: Text;
	private readonly cache = new WidthCache();

	constructor(
		private readonly content: string,
		private readonly styles: ThemeStyles,
		private readonly tone: "dim" | "warning" | "error" | "success" = "dim",
	) {
		this.textComponent = new Text(this.renderText(), 0, 0);
	}

	invalidate(): void {
		this.cache.invalidate();
		this.textComponent.setText(this.renderText());
	}

	private renderText(): string {
		const paint =
			this.tone === "error"
				? this.styles.error
				: this.tone === "warning"
					? this.styles.warning
					: this.tone === "success"
						? this.styles.success
						: this.styles.dim;
		// \r is zero-width to the wrapper: strip it first to avoid rendering blank rows.
		return paint(this.content)
			.replaceAll("\r", "")
			.split("\n")
			.map((line) => `  ${line}`)
			.join("\n");
	}

	render(width: number): string[] {
		return this.cache.render(width, [], (w) =>
			// Fallback truncation: over-long unbreakable content must not exceed the terminal width (pi-tui throws on over-width rows)
			this.textComponent.render(w).map((line) => truncateToWidth(line, w)),
		);
	}
}

export class NoticeMessage implements Component {
	private readonly parts: Text[] = [];

	constructor(title: string, detail: string | undefined, styles: ThemeStyles) {
		this.parts.push(new Text(`  ${styles.bold(title)}`, 0, 0));
		if (detail !== undefined && detail !== "") this.parts.push(new Text(`  ${styles.dim(detail)}`, 0, 0));
	}

	invalidate(): void {
		for (const part of this.parts) part.invalidate();
	}

	render(width: number): string[] {
		const lines: string[] = [""];
		for (const part of this.parts) lines.push(...part.render(width).map((line) => truncateToWidth(line, width)));
		return lines;
	}
}
