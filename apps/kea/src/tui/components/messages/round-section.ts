import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import type { ThemeStyles } from "../../theme.ts";
import { mechanicalSummary } from "./caption-text.ts";
import { SectionCaption, SectionCard, type SectionToolPart } from "./section-card.ts";
import { UserMessageView } from "./user-message.ts";

// One turn = one rounded card + a caption line below it; single source of truth for live/replay grouping.
export class RoundSection implements Component {
	readonly card: SectionCard;
	readonly caption: SectionCaption;
	private agentActivated = false;

	constructor(
		private readonly styles: ThemeStyles,
		requestRender?: () => void,
	) {
		this.card = new SectionCard(styles, "agent");
		this.caption = new SectionCaption("", styles);
		if (requestRender) this.caption.onRedraw = requestRender;
	}

	appendUser(message: AgentMessage): void {
		this.card.addChild(new UserMessageView(message, this.styles));
	}

	/** Agent activity starts: frame color → accent (idempotent). */
	activateAgent(): void {
		if (this.agentActivated) return;
		this.agentActivated = true;
		this.card.setFrame(this.styles.accent);
	}

	addAgentChild(child: Component): void {
		this.card.addChild(child);
	}

	setLive(text: string): void {
		this.caption.setLive(text);
	}

	tick(): void {
		this.caption.tick();
	}

	finish(parts: readonly SectionToolPart[], elapsedMs: number, failed: boolean): void {
		this.card.setFrame(failed ? this.styles.error : this.styles.border);
		this.caption.setSummary(parts.length > 0 ? mechanicalSummary(parts, elapsedMs) : "");
	}

	setSummary(text: string): void {
		this.caption.setSummary(text);
	}

	pushDone(text: string): void {
		this.caption.pushDone(text);
	}

	get hasContent(): boolean {
		return this.card.childCount > 0;
	}

	foldOldSteps(keepSteps: number): number {
		return this.card.foldOldChildren(keepSteps);
	}

	invalidate(): void {
		this.card.invalidate();
		this.caption.invalidate();
	}

	// Renders only the card body — the caption is a separate component, so dynamic caption
	// repaints leave neighboring cards untouched.
	render(width: number): string[] {
		return this.card.render(width);
	}
}
