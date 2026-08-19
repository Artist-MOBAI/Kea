import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeStyles } from "../../theme.ts";
import { WidthCache } from "./render-cache.ts";
import { prefixLines, textContentOf } from "./text-util.ts";

export const USER_BULLET = "> ";
const USER_INDENT = "  ";

export class UserMessageView implements Component {
	readonly flushLeft = true;
	// The ├ junction and `>` share userMark — ├> forms one visual unit.
	readonly junctionPaint: (s: string) => string;
	private readonly textComponent: Text;
	// Content is immutable after construction; invalidated only via invalidate().
	private readonly cache = new WidthCache();

	constructor(
		message: AgentMessage,
		private readonly styles: ThemeStyles,
	) {
		this.junctionPaint = styles.userMark;
		this.textComponent = new Text(textContentOf(message), 0, 0);
	}

	invalidate(): void {
		this.cache.invalidate();
		this.textComponent.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(width, 1);
		return this.cache.render(safeWidth, [], (w) => {
			const contentWidth = Math.max(1, w - visibleWidth(USER_BULLET));
			const contentLines = this.textComponent.render(contentWidth);
			if (contentLines.length === 0) return [];
			return prefixLines(contentLines, this.styles.userMark(USER_BULLET), USER_INDENT).map((line) =>
				truncateToWidth(line, w, "…"),
			);
		});
	}
}
