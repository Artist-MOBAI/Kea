import { renderTranscript } from "../components/transcript.ts";
import type { TUICtx } from "../ctx.ts";

// Replay and live rendering share transcript.ts; trigger points: startup resume, session switch, /new.
export function replayTranscript(ctx: TUICtx): void {
	ctx.clearTranscript();
	ctx.state.toolViews.clear();
	const components = renderTranscript(ctx.kernel.agent.state.messages, {
		styles: ctx.styles(),
		markdownTheme: ctx.markdownTheme(),
		cwd: process.cwd(),
		isExpanded: () => ctx.state.expanded,
		requestRender: () => ctx.tui.requestRender(),
	});
	for (const component of components) ctx.trackComponent(component);
	// Apply the window trim immediately (same helper run_end uses): restored long sessions must not
	// mount all history until the next run_end.
	ctx.trimTranscriptWindow();
	// No in-progress turn after replay: live turns are rebuilt by sendPrompt/ensureAgentSection.
	ctx.state.currentSection = undefined;
	ctx.state.sectionParts = [];
	ctx.tui.requestRender();
}
