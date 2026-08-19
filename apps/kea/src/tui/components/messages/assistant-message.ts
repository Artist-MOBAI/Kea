import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BRANCH_BULLET } from "../../constants/symbols.ts";
import type { ThemeStyles } from "../../theme.ts";
import { WidthCache } from "./render-cache.ts";
import { MESSAGE_INDENT, prefixLines } from "./text-util.ts";
import { ThinkingView } from "./thinking.ts";

export class AssistantMessageView implements Component {
	readonly thinking: ThinkingView;
	readonly flushLeft = true;
	// Body ─ uncolored; the ├ junction is the same raw color (one visual unit).
	readonly junctionPaint = (s: string): string => s;
	private readonly markdown: Markdown;
	private text = "";
	// Width-keyed cache, manually invalidated (update/finalize/invalidate). deps stay empty, not
	// [text]: the same text differs between update (fence padded) and finalize (original), so only
	// explicit invalidation can distinguish them.
	private readonly cache = new WidthCache();

	constructor(
		_message: AgentMessage,
		markdownTheme: MarkdownTheme,
		styles: ThemeStyles,
		isExpanded: () => boolean = () => false,
	) {
		this.markdown = new Markdown("", 0, 0, markdownTheme);
		this.thinking = new ThinkingView(styles, isExpanded);
	}

	invalidate(): void {
		this.cache.invalidate();
		this.markdown.invalidate();
	}

	update(text: string, thinking?: string): void {
		this.text = text;
		this.cache.invalidate();
		this.markdown.setText(trimUnclosedFence(text));
		if (thinking !== undefined && thinking !== "") this.thinking.setText(thinking);
	}

	finalize(text: string): void {
		this.text = text;
		this.cache.invalidate();
		this.markdown.setText(text);
		this.thinking.finalize();
	}

	render(width: number): string[] {
		const display = this.text.trim();
		if (display === "") return [];
		const safeWidth = Math.max(width, 1);
		return this.cache.render(safeWidth, [], (w) => {
			const contentWidth = Math.max(1, w - visibleWidth(BRANCH_BULLET));
			const contentLines = this.markdown.render(contentWidth);
			// No leading blank line: paragraph spacing comes from the user message's spacer semantics.
			return prefixLines(contentLines, BRANCH_BULLET, MESSAGE_INDENT).map((line) => truncateToWidth(line, w, "…"));
		});
	}
}

/** If a code fence is unclosed, append a closing fence at render time to avoid code-block height jitter during streaming. */
export function trimUnclosedFence(text: string): string {
	let fences = 0;
	for (const line of text.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) fences += 1;
	}
	return fences % 2 === 1 ? `${text}\n\`\`\`` : text;
}
