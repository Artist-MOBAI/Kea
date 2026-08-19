import {
	type Component,
	Container,
	type MarkdownTheme,
	ProcessTerminal,
	Text,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import {
	type ApprovalDecision,
	CORE_VERSION,
	createExecutionEnv,
	isRetryableStreamError,
	type Kernel,
	listAvailableModels,
	streamWithRetry,
	TRANSIENT_CONTINUE_TEXT,
	TRANSIENT_TURN_BACKOFF_MS,
	TRANSIENT_TURN_MAX,
} from "@kea/core";
import {
	buildPhasePrompt,
	checkMobaiIn,
	checkProgram,
	determinePhase,
	lastAssistantTextOf,
	loadMobaiIn,
	loadProgram,
	mobaiContinuationPrompt,
	type PhaseDecision,
	packById,
	programPathIn,
	runRoundJudge,
	type SettleState,
	saveProgram,
	settleComplete,
	settleRound,
} from "@kea/research";
import { loadConfig, projectConfigPath } from "../config.ts";
import { escalateEpochWorkers, escalateFreshWorker } from "../program-fresh-worker.ts";
import { ApprovalQueue } from "./approval-queue.ts";
import { dispatchInput, programFormalizationPrompt, type SlashCommandHost } from "./commands/dispatch.ts";
import { BUILTIN_COMMANDS, sortCommands } from "./commands/registry.ts";
import type { KeaSlashCommand } from "./commands/types.ts";
import type { FooterData } from "./components/chrome/footer.ts";
import { FooterView } from "./components/chrome/footer.ts";
import { TodoPanel } from "./components/chrome/todo-panel.ts";
import { WelcomeComponent } from "./components/chrome/welcome.ts";
import { ApprovalPanel, detectDanger } from "./components/dialogs/approval-panel.ts";
import { ApprovalPreviewViewer } from "./components/dialogs/approval-preview.ts";
import { clusterDiffPreview } from "./components/dialogs/diff-cluster.ts";
import { HelpPanel } from "./components/dialogs/help-panel.ts";
import type { TasksPanel } from "./components/dialogs/tasks-panel.ts";
import { RoundedEditor } from "./components/editor/rounded-editor.ts";
import { SlashAwareAutocomplete } from "./components/editor/slash-provider.ts";
import { RoundSection } from "./components/messages/round-section.ts";
import { NoticeMessage, StatusMessage } from "./components/messages/status-message.ts";
import { harnessPromptDisplayLabel } from "./components/transcript.ts";
import { WidthSafe } from "./components/width-safe.ts";
import { FAILURE_MARK, SUCCESS_MARK } from "./constants/symbols.ts";
import { createKeyboardListener, InputHistory } from "./controllers/editor-keyboard.ts";
import { classifyError, hookBlockedMessage, hookBlockedReason } from "./controllers/error-classify.ts";
import { subscribeKernelEvents } from "./controllers/kernel-event-handler.ts";
import {
	openModelPicker,
	openProviderManager,
	openSettingsPanel,
	runAddProviderFlow,
} from "./controllers/model-config.ts";
import {
	openEffortPicker,
	openInfoPanel,
	openPermissionPicker,
	openSessionsPicker,
	openTasksPanel,
	openUndoSelector,
	readJobRows,
} from "./controllers/overlays.ts";
import { replayTranscript } from "./controllers/session-replay.ts";
import { turnsToTrim } from "./controllers/transcript-window.ts";
import type { TUICtx } from "./ctx.ts";
import { KEY_BINDINGS } from "./keybindings.ts";
import { findOrphanMobai, sessionMobaiDir } from "./mobai-dir.ts";
import { isMobaiPaused, pauseMobai, resumeMobai, shiftQueue, unshiftQueue } from "./mobai-lifecycle.ts";
import { createMobaiStateReminderProvider, type MobaiStateSnapshot } from "./mobai-state-reminder.ts";
import { createNotifier } from "./notify.ts";
import { readPlanPreviewText } from "./plan-preview.ts";
import { createTUIState } from "./state.ts";
import { createTheme, type ThemeStyles } from "./theme.ts";
import { detectFdPath } from "./utils/fd-detect.ts";
import { releaseAllSessionLocks } from "./utils/session-lock.ts";

const FOOTER_TICK_MS = 1000;
const EXIT_HINT_TTL_MS = 1500;
const EXIT_CLOSE_TIMEOUT_MS = 2000;
const JOB_ROWS_CACHE_MS = 2000;
const AUTO_CONTINUE_TICK_MS = 1500;

// Races close against a watchdog: timeout/failure resolve false — never rejects.
export async function closeWithWatchdog(close: () => Promise<void>, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs);
		timer.unref?.();
	});
	const done = close().then(
		() => true,
		() => false,
	);
	const result = await Promise.race([done, timeout]);
	if (timer !== undefined) clearTimeout(timer);
	return result;
}

// Teardown order: dispose (SessionEnd hook) → close (MCP shutdown + memory flush); each gets its own
// watchdog window and never rejects.
export async function shutdownKernel(kernel: Pick<Kernel, "dispose" | "close">, timeoutMs: number): Promise<void> {
	await closeWithWatchdog(() => kernel.dispose().catch(() => {}), timeoutMs);
	await closeWithWatchdog(() => kernel.close(), timeoutMs);
}

// Single-flight gate for the approval panel: mounting during a preview build would overwrite
// mountingApproval and lose the displaced request's resolve — the kernel-side await hangs forever.
export function shouldMountNextApproval(shown: boolean, mounting: boolean): boolean {
	return !shown && !mounting;
}

export function contextPctOf(estimate: number, window: number): number {
	return window > 0 ? Math.min(100, Math.max(0, Math.round((estimate / window) * 100))) : 0;
}

/** True when an async refresh straddled a session switch — its writes would resurrect stale session state. */
export function sessionIdentityChanged(entrySessionId: string, currentSessionId: string): boolean {
	return entrySessionId !== currentSessionId;
}

function markdownThemeOf(styles: ThemeStyles): MarkdownTheme {
	const plain = (s: string): string => s;
	return {
		heading: styles.bold,
		link: styles.accent,
		linkUrl: styles.dim,
		code: styles.primary,
		codeBlock: (s) => s,
		codeBlockBorder: styles.faint,
		quote: styles.dim,
		quoteBorder: styles.faint,
		hr: styles.faint,
		listBullet: styles.primary,
		bold: styles.bold,
		italic: styles.italic ?? plain,
		strikethrough: styles.strikethrough ?? plain,
		underline: styles.underline ?? plain,
	};
}

export interface TuiOptions {
	/** Exit teardown hook: called after kernel.dispose()/close() and before process.exit (e.g. research-layer SQLite handle release). */
	onExit?: () => void;
	/** Round stamp pushed before every auto-continue round; without it every ledger entry is stamped round=1 and per-round progress attribution goes blind. */
	onProgramRound?: (round: number) => void;
}

export class KeaTUI {
	private readonly terminal = new ProcessTerminal();
	private readonly tui = new TuiMainScreen(this.terminal, true);
	private readonly transcript = new Container();
	private readonly editorSlot = new Container();
	private readonly editor: RoundedEditor;
	private readonly footerView: FooterView;
	private readonly todoPanel: TodoPanel;
	private readonly notifier = createNotifier();
	private readonly history = new InputHistory(process.cwd());
	private readonly state = createTUIState();
	private readonly ctx: TUICtx;
	private readonly host: SlashCommandHost;
	private readonly approvalQueue = new ApprovalQueue();
	private readonly disposables: Array<() => void> = [];
	private disposed = false;

	private styles: ThemeStyles;
	private markdownTheme: MarkdownTheme;
	private readonly onExit?: () => void;
	private readonly onProgramRound?: (round: number) => void;
	private tasksPanel?: TasksPanel;
	private jobRowsCache?: { at: number; rows: Awaited<ReturnType<typeof readJobRows>> };
	private footerInFlight = false;
	/** Refresh requests arriving during an in-flight refresh are not dropped: rerun once when it finishes. */
	private footerDirty = false;
	private mobaiActive = false;
	private mobaiStateSnapshot: MobaiStateSnapshot = {
		status: undefined,
		kind: undefined,
		objective: undefined,
		paused: false,
	};
	private transientErrorStreak = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	/** An approval whose async preview build is in flight (deniable before the panel mounts). */
	private mountingApproval?: { resolve: (decision: ApprovalDecision) => void; cancel: () => void };
	private programAutoRounds = 0;
	// Journal-absolute round at (re)arm: the auto-round cap counts rounds ADDED by this process,
	// so a journal already at round 25 with cap 20 still gets its 20 rounds.
	private programAutoRoundsBaseline = 0;
	// Generation token for escalation awaits: manual prompt / session switch / mobai pause bumps it;
	// an await resolving with a stale token discards its result — no settle writes, no timer armed.
	private autoGeneration = 0;
	private escalationAbort: AbortController | undefined;

	private invalidateAutoContinue(): void {
		this.autoGeneration++;
		if (this.autoContinueTimer !== undefined) {
			clearTimeout(this.autoContinueTimer);
			this.autoContinueTimer = undefined;
		}
	}

	// Clear the abort slot only when still ours (a newer escalation window may have replaced it).
	private async runEscalation<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		this.escalationAbort = controller;
		try {
			return await fn(controller.signal);
		} finally {
			if (this.escalationAbort === controller) this.escalationAbort = undefined;
		}
	}

	private interruptEscalation(): boolean {
		if (this.escalationAbort === undefined) return false;
		this.escalationAbort.abort();
		this.escalationAbort = undefined;
		this.invalidateAutoContinue();
		void this.pauseActiveMobaiIfAny();
		return true;
	}

	// Rebase to the ledger's max round: restarting at 1 would let historical round-1 entries grant free progress.
	private async rebaseAutoRoundsNow(): Promise<number> {
		const generation = this.autoGeneration;
		const p = await loadProgram(sessionMobaiDir(process.cwd(), this.kernel.sessionId));
		if (this.autoGeneration !== generation) return this.programAutoRounds;
		this.programAutoRounds = p ? p.journal.reduce((m, e) => Math.max(m, e.round), 0) : 0;
		this.programAutoRoundsBaseline = this.programAutoRounds;
		return this.programAutoRounds;
	}

	private rebaseAutoRounds(): void {
		void this.rebaseAutoRoundsNow();
	}
	private autoSettle: SettleState = {
		pairing: undefined,
		phaseStuck: undefined,
		analysisDue: false,
		roundsSinceProgress: 0,
	};
	private lastAutoPhase: PhaseDecision | undefined;
	private autoContinueTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly kernel: Kernel,
		options: TuiOptions = {},
	) {
		this.styles = createTheme();
		this.markdownTheme = markdownThemeOf(this.styles);
		this.onExit = options.onExit;
		this.onProgramRound = options.onProgramRound;

		this.editor = new RoundedEditor(
			this.tui,
			{
				borderColor: this.styles.border,
				selectList: {
					selectedPrefix: this.styles.accent,
					selectedText: this.styles.bold,
					description: this.styles.dim,
					scrollInfo: this.styles.dim,
					noMatch: this.styles.dim,
				},
			},
			undefined,
			{ styles: this.styles, argumentHints: this.buildArgumentHints() },
		);
		this.editor.setAutocompleteProvider(
			new SlashAwareAutocomplete(BUILTIN_COMMANDS as readonly KeaSlashCommand[], process.cwd(), detectFdPath()),
		);
		this.editor.onSubmit = (text) => this.onSubmit(text);
		this.editorSlot.addChild(this.editor);

		this.footerView = new FooterView(this.styles);
		this.disposables.push(() => this.footerView.dispose());
		this.todoPanel = new TodoPanel(this.styles);
		this.ctx = this.buildCtx();
		this.host = this.buildHost();
		this.kernel.approvalHandler = (req) => this.handleApproval(req);
	}

	start(): void {
		void this.boot();
	}

	private async boot(): Promise<void> {
		this.tui.addInputListener(createKeyboardListener(this.ctx));
		this.tui.addChild(this.transcript);
		this.tui.addChild(this.todoPanel);
		this.tui.addChild(this.editorSlot);
		this.tui.addChild(this.footerView.component);
		this.tui.setFocus(this.editor);

		await this.mountWelcome();
		if (this.kernel.agent.state.messages.length > 0) {
			replayTranscript(this.ctx);
			this.todoPanel.setTodos(this.kernel.todos);
			if (this.kernel.wasInterrupted) this.showStatus("Last run was interrupted; transcript restored", "warning");
			// Resuming a session auto-pauses its active mobai — it must not silently keep running after a cold restore.
			void this.pauseActiveMobaiIfAny();
		} else {
			void this.notifyOrphanMobai();
		}
		this.disposables.push(subscribeKernelEvents(this.ctx));
		this.disposables.push(
			this.kernel.events.subscribe((event) => {
				if (event.type === "session_switched") {
					this.onSessionSwitched();
					return;
				}
				if (event.type !== "run_end") return;
				// In-flight approvals end with the run: on abort/end the awaits inside the kernel won't resolve on their own, so they all settle as deny
				this.denyPendingApprovals();
				if (event.outcome === "completed") {
					this.transientErrorStreak = 0;
					this.drainSteerQueue();
					void this.maybeAutoContinueProgram();
					return;
				}
				// Esc abort pauses an active mobai: the user stopped it — auto-continue must not resume on its own.
				if (event.outcome === "aborted") {
					void this.pauseActiveMobaiIfAny();
					return;
				}
				if (event.outcome === "failed" && event.error !== undefined && isRetryableStreamError(event.error)) {
					if (this.transientErrorStreak < TRANSIENT_TURN_MAX) {
						this.transientErrorStreak++;
						this.showStatus(
							`Network error — retrying (${this.transientErrorStreak}/${TRANSIENT_TURN_MAX})…`,
							"warning",
						);
						if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
						this.retryTimer = setTimeout(() => {
							// The world may have moved on since the timer was armed — disposed, a new run, or a session switch cancels the retry.
							if (this.disposed || this.kernel.agent.state.isStreaming) return;
							this.sendPrompt(TRANSIENT_CONTINUE_TEXT, { rearm: false, display: "system" });
						}, TRANSIENT_TURN_BACKOFF_MS);
					} else {
						this.showError(`Network error persists after ${TRANSIENT_TURN_MAX} attempts: ${event.error}`);
						this.transientErrorStreak = 0;
					}
				}
			}),
		);
		this.disposables.push(() => {
			if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
			if (this.autoContinueTimer !== undefined) clearTimeout(this.autoContinueTimer);
		});

		this.tui.start();
		this.startJobWatcher();
		this.startFooterTicker();
		this.kernel.injections.register(createMobaiStateReminderProvider(() => this.mobaiStateSnapshot));
		void this.history.load().then((entries) => {
			if (this.disposed) return;
			for (const entry of entries) this.editor.addToHistory(entry);
		});
		this.refreshFooter();
	}

	private exit(): void {
		this.dispose();
		this.tui.stop();
		void this.shutdown();
	}

	private dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		// single-writer discipline: release every lock this process holds (current + still-held prior
		// sessions) so other processes may open them
		releaseAllSessionLocks();
		for (const dispose of this.disposables.splice(0)) {
			try {
				dispose();
			} catch {}
		}
	}

	private async shutdown(): Promise<void> {
		await shutdownKernel(this.kernel, EXIT_CLOSE_TIMEOUT_MS);
		try {
			this.onExit?.();
		} catch {}
		process.exit(0);
	}

	private addText(text: string): void {
		this.transcript.addChild(new Text(text, 2, 0));
		this.tui.requestRender();
	}

	private showStatus(text: string, tone: "dim" | "warning" | "error" | "success" = "dim"): void {
		this.transcript.addChild(new StatusMessage(text, this.styles, tone));
		this.tui.requestRender();
	}

	private showError(text: string): void {
		this.transcript.addChild(new StatusMessage(`Error: ${text}`, this.styles, "error"));
		this.tui.requestRender();
	}

	private showNotice(title: string, detail?: string): void {
		this.transcript.addChild(new NoticeMessage(title, detail, this.styles));
		this.tui.requestRender();
	}

	// Rendering-only trim: the full transcript lives in the session ledger, recoverable via replay/export.
	private trimTranscriptWindow(): void {
		const children = this.transcript.children;
		const sections: Array<{ wrapper: Component; section: RoundSection }> = [];
		for (const child of children) {
			const inner = child instanceof WidthSafe ? child.wrapped : child;
			if (inner instanceof RoundSection) sections.push({ wrapper: child, section: inner });
		}
		const removeCount = turnsToTrim(sections.length);
		if (removeCount <= 0) return;
		const removed = sections.slice(0, removeCount);
		const removedCaptions = new Set<Component>(removed.map((s) => s.section.caption));
		for (const child of [...children]) {
			const inner = child instanceof WidthSafe ? child.wrapped : child;
			if (removed.some((s) => s.section === inner) || removedCaptions.has(inner)) {
				this.transcript.removeChild(child);
			}
		}
		this.tui.requestRender();
	}

	private mountEditorReplacement(component: Component, dialog = "dialog"): void {
		this.editorSlot.clear();
		this.editorSlot.addChild(component);
		this.tui.setFocus(component);
		this.state.activeDialog = dialog;
		this.tui.requestRender();
	}

	private restoreEditor(): void {
		this.editorSlot.clear();
		this.editorSlot.addChild(this.editor);
		this.tui.setFocus(this.editor);
		this.state.activeDialog = undefined;
		this.tui.requestRender();
	}

	private onSubmit(text: string): void {
		const trimmed = text.trim();
		if (trimmed === "") return;
		// Slash dispatch means the FIRST line: a multi-line draft whose command-looking text sits on a
		// later line (Ctrl+J) is a prompt — this gate must match the completion surface (editor line 0).
		const firstLine = (text.split("\n", 1)[0] ?? "").trim();
		if (firstLine.startsWith("/")) {
			this.editor.setText("");
			this.history.record(trimmed);
			void dispatchInput(this.host, this.kernel, trimmed).then(({ handled }) => {
				if (handled) return;
				if (this.kernel.agent.state.isStreaming) {
					this.enqueueSteer(trimmed);
					return;
				}
				this.sendPrompt(trimmed);
			});
			return;
		}
		if (this.kernel.agent.state.isStreaming) {
			this.editor.setText("");
			this.history.record(trimmed);
			this.enqueueSteer(trimmed);
			return;
		}
		this.editor.setText("");
		this.history.record(trimmed);
		this.sendPrompt(trimmed);
	}

	private enqueueSteer(trimmed: string): void {
		this.state.steerQueue.push(trimmed);
		this.showStatus(`Queued; sent after the current round ends (${this.state.steerQueue.length} in queue)`);
		this.refreshFooter();
	}

	private sendPrompt(
		text: string,
		opts: { rearm?: boolean; display?: "bubble" | "system"; echo?: string } = {},
	): Promise<boolean> {
		const { rearm = true, display = "bubble", echo } = opts;
		if (rearm) {
			// Manual input cancels any pending auto round (its timer must not fire into the user's run)
			// and invalidates in-flight escalation awaits.
			this.invalidateAutoContinue();
			this.rebaseAutoRounds();
			this.autoSettle = { pairing: undefined, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 0 };
			this.lastAutoPhase = undefined;
		}
		// display:"system" renders a dim continuation header; echo renders the typed command line as the
		// user bubble while the expanded template goes to the model (display ≠ sent, by design).
		const section = new RoundSection(this.styles, () => this.tui.requestRender());
		if (echo !== undefined) {
			const userMessage = { role: "user", content: [{ type: "text", text: echo }], timestamp: Date.now() };
			section.appendUser(userMessage as never);
		} else if (display === "system") {
			section.addAgentChild(new StatusMessage(`· ${harnessPromptDisplayLabel(text)}`, this.styles, "dim"));
		} else {
			const userMessage = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
			section.appendUser(userMessage as never);
		}
		this.state.currentSection = section;
		this.state.sectionParts = [];
		this.state.sectionStartedAt = Date.now();
		this.ctx.trackComponent(section);
		this.ctx.trackComponent(section.caption);
		// Resolves false when the submission never entered the session (re-entrancy guard, hook block) —
		// callers holding consumed state (e.g. a shifted queue head) roll back on false.
		return this.kernel
			.prompt(text)
			.then(
				() => true,
				(err) => {
					const blocked = hookBlockedReason(err);
					if (blocked !== undefined) {
						this.abortBlockedRound(section, echo ?? text, blocked, echo !== undefined ? "bubble" : display);
						return false;
					}
					this.showError(classifyError(err instanceof Error ? err.message : String(err)));
					return false;
				},
			)
			.finally(() => this.refreshFooter());
	}

	// After a completed turn, keep driving an active session program/mobai through the same shared
	// settlement module as headless. Rounds are unlimited by default; program_auto_max_rounds opts into a cap.
	private async maybeAutoContinueProgram(): Promise<void> {
		if (this.disposed || this.kernel.agent.state.isStreaming) return;
		const mobaiDir = sessionMobaiDir(process.cwd(), this.kernel.sessionId);
		if (await isMobaiPaused(mobaiDir)) return;

		// Session switches and /mobai pause bump autoGeneration; any await below can straddle one, so
		// every side effect (round stamps, counters, timers, queue prompts) re-checks superseded() first.
		const entryGeneration = this.autoGeneration;
		const superseded = () => this.autoGeneration !== entryGeneration;

		// Resume/boot ignition never passes through sendPrompt's rebase: await it here so the first
		// stamped round is journal-max + 1, not a colliding round 1 (per-round attribution goes blind).
		await this.rebaseAutoRoundsNow();
		if (superseded()) return;

		const program = await loadProgram(mobaiDir);
		let prompt: string | undefined;
		let label: string;
		if (program && program.status === "active") {
			// Machine-check the criteria first: completion is never model-claimed.
			const { env } = await createExecutionEnv(process.cwd());
			const results = await checkProgram(process.cwd(), env, program, (cmd) => this.kernel.reviewMobaiCommand(cmd));
			if (superseded()) return;
			if (results.every((r) => r.passed)) {
				try {
					await saveProgram(
						mobaiDir,
						// the round that actually ran (headless parity, never a phantom +1); an empty-journal
						// first round floors at 1 — round 0 fails the journal schema and poisons the ledger
						settleComplete(program, Math.max(1, this.programAutoRounds), `${results.length} criteria machine-verified`),
					);
				} catch {
					// already complete (e.g. a concurrent /mobai check settled it) — not an error
				}
				this.showStatus("Program complete — every machine criterion passes (✓)", "success");
				this.rebaseAutoRounds();
				this.autoSettle = { pairing: undefined, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 0 };
				this.lastAutoPhase = undefined;
				await this.advanceMobaiQueue(mobaiDir);
				return;
			}

			if (this.lastAutoPhase !== undefined) {
				const settled = settleRound({
					program,
					prev: this.autoSettle,
					phase: this.lastAutoPhase,
					lastAssistantText: lastAssistantTextOf(this.kernel.agent.state.messages as never),
					round: this.programAutoRounds,
				});
				this.autoSettle = settled.next;
				if (settled.next.analysisDue) {
					this.showStatus(
						`Auto round settled: ${[
							settled.attackRefuted ? "refuted attack" : null,
							settled.mismatchDeclared ? "instrument mismatch" : null,
							settled.pairingStuckForced ? "pairing stuck" : null,
							settled.phaseStuckForced
								? `phase ${this.lastAutoPhase.kind} stuck ×${settled.next.phaseStuck?.repeats ?? 0}`
								: null,
						]
							.filter(Boolean)
							.join(" + ")} → next round ANALYZE`,
						"dim",
					);
				}
				// Quiet round: judge first (fresh-context semantic verdict — prose is never scanned by the
				// engine), then fresh worker escalation; an epoch decision spawns nothing here — the next
				// round IS the epoch round.
				if (!settled.madeProgress && !settled.next.analysisDue) {
					const quietDecision = determinePhase(program, false, settled.next.roundsSinceProgress);
					if (quietDecision.kind !== "epoch") {
						const lastPhase = this.lastAutoPhase;
						const generation = this.autoGeneration;
						const verdict = await this.runEscalation((signal) =>
							runRoundJudge(
								this.kernel.subagents,
								{
									objective: program.objective,
									round: this.programAutoRounds,
									phaseKind: lastPhase?.kind ?? "attack",
									target:
										lastPhase?.kind === "attack" ? { id: lastPhase.node.id, title: lastPhase.node.title } : undefined,
									roundText: lastAssistantTextOf(this.kernel.agent.state.messages as never),
									journalDelta: program.journal
										.filter((e) => e.round === this.programAutoRounds)
										.map((e) => e.description),
								},
								signal,
							),
						);
						if (this.autoGeneration !== generation) {
							this.showStatus("auto-continue superseded", "dim");
							return;
						}
						if (verdict?.classification === "abandonment" || verdict?.classification === "external_blocker") {
							this.autoSettle = { ...this.autoSettle, analysisDue: true };
							this.showStatus(`Auto round judged: ${verdict.classification} → next round ANALYZE`, "dim");
						} else {
							const landed = await this.runEscalation((signal) =>
								escalateFreshWorker(this.kernel, program, quietDecision, mobaiDir, this.programAutoRounds, signal),
							);
							if (this.autoGeneration !== generation) {
								this.showStatus("auto-continue superseded", "dim");
								return;
							}
							if (landed) this.autoSettle = { ...this.autoSettle, roundsSinceProgress: 0 };
						}
					}
				}
			}

			const phase = determinePhase(program, this.autoSettle.analysisDue, this.autoSettle.roundsSinceProgress);
			const cap = await this.autoRoundCap();
			// Mirror of the pre-stamp guard below: a switch straddling the config read must not stamp
			// the epoch round or bump counters into the new session.
			if (superseded()) return;
			const round = this.programAutoRounds + 1;
			if (cap > 0 && this.programAutoRounds - this.programAutoRoundsBaseline >= cap) {
				this.showStatus(
					`Program paused after ${cap} auto-rounds (program_auto_max_rounds) — /mobai status to inspect; send any message to resume`,
					"warning",
				);
				return;
			}
			// Epoch rung: no in-session prompt — the round's work goes to blank fresh workers; landed
			// work resets the ladder, otherwise the focus rotates next epoch round.
			if (phase.kind === "epoch") {
				this.onProgramRound?.(round);
				this.programAutoRounds++;
				this.showStatus(
					`Program auto-continue${cap > 0 ? ` (${this.programAutoRounds - this.programAutoRoundsBaseline}/${cap})` : ` (${this.programAutoRounds})`}: epoch:${phase.focuses.join("+")}`,
				);
				// Workers run for minutes: a manual prompt, session switch, or Esc during the window
				// invalidates whatever they land (stale generation discard).
				const generation = this.autoGeneration;
				const landed = await this.runEscalation((signal) =>
					escalateEpochWorkers(this.kernel, program, phase, mobaiDir, round, signal),
				);
				if (this.autoGeneration !== generation) {
					this.showStatus("auto-continue superseded", "dim");
					return;
				}
				this.lastAutoPhase = undefined;
				this.autoSettle = {
					pairing: undefined,
					phaseStuck: undefined,
					analysisDue: false,
					roundsSinceProgress: landed ? 0 : this.autoSettle.roundsSinceProgress + 1,
				};
				this.autoContinueTimer = setTimeout(() => {
					if (this.disposed || this.kernel.agent.state.isStreaming) return;
					void this.maybeAutoContinueProgram();
				}, AUTO_CONTINUE_TICK_MS);
				return;
			}
			// Stamp the round BEFORE submission so this round's journal entries carry the driving round.
			if (superseded()) return;
			this.onProgramRound?.(round);
			prompt = buildPhasePrompt({
				program,
				phase,
				round,
				// No cap → no "/max" in the round tag: "last round" framing makes models wrap up. The
				// planned last round stays journal-absolute (headless parity): baseline + cap.
				maxRounds: cap > 0 ? this.programAutoRoundsBaseline + cap : undefined,
				failing: results.filter((r) => !r.passed).map((r) => `- ${r.description} (${r.detail})`),
				// Persisted discipline: a metric program must not degrade to math vocabulary on continue.
				pack: packById(program.discipline),
				programPath: programPathIn(mobaiDir),
			});
			this.lastAutoPhase = phase;
			label =
				phase.kind === "attack"
					? `attack:${phase.node.id}`
					: phase.kind === "invent"
						? `invent:v${phase.latestVersion + 1}`
						: phase.kind === "reform"
							? `reform:${phase.mode}`
							: phase.kind === "replan"
								? "replan"
								: phase.kind === "extend"
									? "extend"
									: "analyze";
			this.programAutoRounds++;
			this.showStatus(
				`Program auto-continue${cap > 0 ? ` (${this.programAutoRounds - this.programAutoRoundsBaseline}/${cap})` : ` (${this.programAutoRounds})`}: ${label}`,
			);
		} else {
			const mobai = await loadMobaiIn(mobaiDir);
			if (mobai?.status !== "active") return;
			const { env } = await createExecutionEnv(process.cwd());
			const { mobai: checked, results } = await checkMobaiIn(process.cwd(), mobaiDir, env, (cmd) =>
				this.kernel.reviewMobaiCommand(cmd),
			);
			if (superseded()) return;
			if (checked.status === "complete") {
				this.showStatus("Mobai complete — every machine criterion passes (✓)", "success");
				this.rebaseAutoRounds();
				this.autoSettle = { pairing: undefined, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 0 };
				this.lastAutoPhase = undefined;
				await this.advanceMobaiQueue(mobaiDir);
				return;
			}
			const cap = await this.autoRoundCap();
			// Mirror of the program branch: a switch straddling the config read must not stamp the
			// legacy round or arm its timer into the new session.
			if (superseded()) return;
			if (cap > 0 && this.programAutoRounds - this.programAutoRoundsBaseline >= cap) {
				this.showStatus(
					`Mobai paused after ${cap} auto-rounds (program_auto_max_rounds) — send any message to resume`,
					"warning",
				);
				return;
			}
			// failing carries the real machine results — never [].
			prompt = mobaiContinuationPrompt({
				round: this.programAutoRounds + 1,
				maxRounds: cap,
				objective: mobai.objective,
				failing: results.filter((r) => !r.passed).map((r) => `- ${r.description} (${r.detail})`),
			});
			label = "mobai continuation";
			this.programAutoRounds++;
			this.showStatus(
				`Mobai auto-continue${cap > 0 ? ` (${this.programAutoRounds - this.programAutoRoundsBaseline}/${cap})` : ` (${this.programAutoRounds})`}: ${label}`,
			);
		}

		if (prompt === undefined) return;
		if (superseded()) return;
		this.armAutoContinuePrompt(prompt);
	}

	// Auto-round submission: a blocked send (re-entrancy/hook block) must not burn the already-stamped
	// round — re-arm ONE short retry with the same idle guards.
	private armAutoContinuePrompt(text: string): void {
		this.autoContinueTimer = setTimeout(() => {
			if (this.disposed || this.kernel.agent.state.isStreaming) return;
			void this.sendPrompt(text, { rearm: false, display: "system" }).then((sent) => {
				if (sent || this.disposed || this.kernel.agent.state.isStreaming) return;
				this.autoContinueTimer = setTimeout(() => {
					if (this.disposed || this.kernel.agent.state.isStreaming) return;
					void this.sendPrompt(text, { rearm: false, display: "system" });
				}, AUTO_CONTINUE_TICK_MS);
			});
		}, AUTO_CONTINUE_TICK_MS);
	}

	// A pending auto-continue must not inject the old session's program prompt into the new one.
	private onSessionSwitched(): void {
		// A stale escalation window from the old session must not turn a post-switch Esc into a pause
		// of the NEW session's mobai — abort it and clear the slot, pausing nothing here.
		if (this.escalationAbort !== undefined) {
			this.escalationAbort.abort();
			this.escalationAbort = undefined;
		}
		this.invalidateAutoContinue();
		if (this.retryTimer !== undefined) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		this.rebaseAutoRounds();
		this.transientErrorStreak = 0;
		this.autoSettle = { pairing: undefined, phaseStuck: undefined, analysisDue: false, roundsSinceProgress: 0 };
		this.lastAutoPhase = undefined;
		// The reminder snapshot is read at request-assembly time and refreshFooter refills it async:
		// reset synchronously so a request right after the switch never sees the old session's mobai.
		this.mobaiStateSnapshot = { status: undefined, kind: undefined, objective: undefined, paused: false };
		this.mobaiActive = false;
		// Warm switches get the same guard as a cold restore: an active mobai in the session we just
		// entered must not silently resume on the next message — /mobai resume is the explicit gate.
		void this.pauseActiveMobaiIfAny();
	}

	private async pauseActiveMobaiIfAny(): Promise<void> {
		const mobaiDir = sessionMobaiDir(process.cwd(), this.kernel.sessionId);
		const program = await loadProgram(mobaiDir);
		const mobai = program ? undefined : await loadMobaiIn(mobaiDir);
		if (program?.status === "active" || mobai?.status === "active") {
			if (await pauseMobai(mobaiDir)) {
				this.showStatus("Mobai paused (interrupted) — /mobai resume to continue", "warning");
			}
		}
	}

	private async notifyOrphanMobai(): Promise<void> {
		const orphan = await findOrphanMobai(process.cwd(), this.kernel.sessionId);
		if (orphan !== undefined) {
			const state = orphan.paused ? "Paused mobai" : "Active mobai";
			this.showStatus(`${state} in session ${orphan.sid.slice(0, 8)} — /sessions to return`, "warning");
		}
	}

	/** kea.toml `program_auto_max_rounds`: 0/unset = unlimited continuation. */
	private async autoRoundCap(): Promise<number> {
		try {
			const config = await loadConfig(projectConfigPath(process.cwd()));
			const value = config.program_auto_max_rounds;
			return typeof value === "number" && value > 0 ? Math.floor(value) : 0;
		} catch {
			return 0;
		}
	}

	private async advanceMobaiQueue(mobaiDir: string): Promise<void> {
		const generation = this.autoGeneration;
		const next = await shiftQueue(mobaiDir);
		if (next === undefined) return;
		// A switch/pause during the shift must not inject the old session's queued objective elsewhere —
		// and must not drop the head either.
		if (this.autoGeneration !== generation) {
			await unshiftQueue(mobaiDir, next);
			return;
		}
		// The completing objective's paused marker must not silence the next queued one (mirrors
		// cancel/replace/clear clearing the marker before a new objective starts).
		await resumeMobai(mobaiDir);
		this.showStatus("Starting next queued mobai", "dim");
		const submitted = await this.sendPrompt(programFormalizationPrompt(next), { rearm: false, display: "system" });
		if (!submitted) {
			// The objective never entered the session (re-entrancy guard / hook block): without the
			// write-back to the FRONT the queue head is lost forever.
			await unshiftQueue(mobaiDir, next);
			this.showStatus("Queued objective kept — a run was already in progress; it stays queued", "warning");
		}
	}

	// Hook block = the prompt never entered the session: the user card is a phantom. Restore the editor
	// only when empty (never overwrite a newer draft); echo prompts restore the typed line, never the template.
	private abortBlockedRound(
		section: RoundSection,
		text: string,
		reason: string,
		display: "bubble" | "system" = "bubble",
	): void {
		if (this.state.currentSection === section) {
			this.state.currentSection = undefined;
			this.state.sectionParts = [];
		}
		this.removeTracked(section);
		this.removeTracked(section.caption);
		if (display === "bubble" && this.editor.getText() === "") this.editor.setText(text);
		this.showError(hookBlockedMessage(reason));
		this.tui.requestRender();
	}

	private removeTracked(component: Component): void {
		for (const child of [...this.transcript.children]) {
			const inner = child instanceof WidthSafe ? child.wrapped : child;
			if (inner === component) this.transcript.removeChild(child);
		}
	}

	private drainSteerQueue(): void {
		const next = this.state.steerQueue.shift();
		if (next === undefined) return;
		this.refreshFooter();
		this.showStatus(`Sending queued message: ${next.length > 60 ? `${next.slice(0, 60)}…` : next}`);
		void this.sendPrompt(next).then((sent) => {
			if (sent) return;
			// The shift was consumed but the message never entered the session (re-entrancy/hook
			// block): restore it to the FRONT or the queued message is silently lost.
			this.state.steerQueue.unshift(next);
			this.showStatus("Queued message was not sent (submission blocked) — it stays first in the queue", "warning");
			this.refreshFooter();
		});
	}

	private async buildApprovalPreview(toolName: string, args: Record<string, unknown>): Promise<string[] | undefined> {
		const s = this.styles;
		if (toolName === "write" && typeof args.content === "string") {
			return (args.content as string).split("\n").map((l) => s.dim(l));
		}
		if (toolName === "edit") {
			const path = typeof args.path === "string" ? (args.path as string) : "";
			// pi edit contract: edits[] array (after normalize); legacy top-level oldText/newText also accepted
			const edits: Array<{ oldText: string; newText: string }> = [];
			if (Array.isArray(args.edits)) {
				for (const e of args.edits as Array<Record<string, unknown> | undefined>) {
					if (e && typeof e.oldText === "string" && typeof e.newText === "string") {
						edits.push({ oldText: e.oldText, newText: e.newText });
					}
				}
			} else if (typeof args.oldText === "string" && typeof args.newText === "string") {
				edits.push({ oldText: args.oldText as string, newText: args.newText as string });
			}
			if (edits.length === 0) return undefined;
			const out: string[] = [];
			for (const ed of edits) {
				const clustered = clusterDiffPreview(ed.oldText, ed.newText, path);
				if (clustered !== undefined) {
					for (const l of clustered) {
						if (l.kind === "header") out.push(s.bold(l.text));
						else if (l.kind === "add") out.push(s.success(`+ ${l.text}`));
						else if (l.kind === "delete") out.push(s.error(`- ${l.text}`));
						else if (l.kind === "gap") out.push(s.faint(`  ${l.text}`));
						else out.push(s.dim(`  ${l.text}`));
					}
				} else {
					for (const l of ed.oldText.split("\n")) out.push(s.error(`- ${l}`));
					for (const l of ed.newText.split("\n")) out.push(s.success(`+ ${l}`));
				}
			}
			return out.length > 0 ? out : undefined;
		}
		if (toolName === "exit_plan_mode") {
			// The plan read must be fault-tolerant: a throw would reject the approval promise —
			// the panel never appears and the user is stuck in plan mode.
			const planPath = this.kernel.plan.path;
			const text = await readPlanPreviewText(planPath);
			if (text === undefined) {
				return [planPath ? s.dim("(plan file unreadable)") : s.faint("(plan file is empty)")];
			}
			const trimmed = text.trim();
			if (trimmed === "") return [s.faint("(plan file is empty)")];
			return trimmed.split("\n").map((l) => s.dim(l));
		}
		return undefined;
	}

	private handleApproval(req: Parameters<NonNullable<Kernel["approvalHandler"]>>[0]): Promise<ApprovalDecision> {
		const argsObj = (typeof req.args === "object" && req.args !== null ? req.args : {}) as Record<string, unknown>;
		const command = req.kind === "exec" ? req.command : undefined;
		const path = typeof argsObj.path === "string" ? argsObj.path : undefined;
		this.notifier.notify("approval-requested", req.toolName);
		const { promise, resolve } = Promise.withResolvers<ApprovalDecision>();
		// Single panel slot: overwriting directly would drop the displaced request's resolve —
		// the kernel-side await hangs forever (queue and mount in order instead).
		const mount = () => {
			// Mount only after the async preview read finishes; cancel() on run_end suppresses the
			// mount — the resolve still settles deny, no zombie panel or dangling await.
			let canceled = false;
			this.mountingApproval = {
				resolve,
				cancel: () => {
					canceled = true;
				},
			};
			void this.buildApprovalPreview(req.toolName, argsObj)
				.then((preview) => {
					if (canceled) {
						// The deny path already drained the queue; this clear is defensive —
						// the guarded drain prevents a double mount.
						if (this.mountingApproval?.resolve === resolve) this.mountingApproval = undefined;
						this.mountNextApproval();
						return;
					}
					this.mountingApproval = undefined;
					const panel = new ApprovalPanel({
						toolName: req.toolName,
						command,
						path,
						danger: detectDanger(command) ?? this.kernel.reviewExec(command),
						preview,
						styles: this.styles,
					});
					if (preview) {
						panel.onPreview = () => {
							const viewer = new ApprovalPreviewViewer({
								title: path ?? command ?? req.toolName,
								lines: preview,
								rows: this.terminal.rows,
								styles: this.styles,
								onClose: () => this.mountEditorReplacement(panel, "approval"),
							});
							this.mountEditorReplacement(viewer, "approval-preview");
						};
					}
					// Ctrl+O global expand is handled centrally by editor-keyboard's input listener; the panel doesn't manage it
					this.state.approval = {
						resolve,
						toolName: req.toolName,
						command,
						path,
						danger: detectDanger(command) ?? this.kernel.reviewExec(command),
						close: () => this.restoreEditor(),
					};
					panel.onDecision = (decision) => {
						if (decision.kind === "approve") this.ctx.resolveApproval("approve");
						else if (decision.kind === "approve-session") {
							this.kernel.rememberApproval(req);
							this.ctx.resolveApproval("approve");
							this.showStatus(`${req.toolName} auto-approved for this session (same request shape)`);
						} else {
							const answer: ApprovalDecision = decision.feedback
								? { decision: "deny", feedback: decision.feedback }
								: "deny";
							this.ctx.resolveApproval(answer);
							this.showStatus(decision.feedback ? `Denied (feedback: ${decision.feedback})` : "Denied");
						}
					};
					// Approval evicts any open dialog (security-critical and time-sensitive); after the
					// decision only the editor is restored, not the dialog.
					this.mountEditorReplacement(panel, "approval");
					this.mountNextApproval();
				})
				.catch((err: unknown) => {
					// A throw inside the preview chain must not orphan the resolve — the kernel-side
					// await would hang forever. Settle deny exactly once, then keep the queue moving.
					if (canceled) return;
					if (this.mountingApproval?.resolve === resolve) this.mountingApproval = undefined;
					const current = this.state.approval;
					if (current?.resolve === resolve) {
						this.state.approval = undefined;
						current.close?.();
					}
					resolve("deny");
					this.showError(`approval preview failed: ${err instanceof Error ? err.message : String(err)}`);
					this.restoreEditor();
					this.mountNextApproval();
				});
		};
		this.approvalQueue.enqueue({ mount, resolve });
		if (shouldMountNextApproval(this.state.approval !== undefined, this.mountingApproval !== undefined))
			this.mountNextApproval();
		return promise;
	}

	private mountNextApproval(): void {
		if (!shouldMountNextApproval(this.state.approval !== undefined, this.mountingApproval !== undefined)) return;
		this.approvalQueue.shiftNext()?.mount();
	}

	// The abort signal can't reach the promise awaited inside the handler — without actively deciding,
	// the kernel-side await hangs forever. Everything settles as deny.
	private denyPendingApprovals(): void {
		const current = this.state.approval;
		const queuedCount = this.approvalQueue.denyAll();
		let deniedMounting = false;
		if (this.mountingApproval !== undefined) {
			// A still-building preview has no panel yet — settle it here or it mounts after the run ended.
			const mounting = this.mountingApproval;
			this.mountingApproval = undefined;
			mounting.cancel();
			mounting.resolve("deny");
			deniedMounting = true;
		}
		if (current) {
			this.state.approval = undefined;
			current.close?.();
			current.resolve("deny");
		}
		if (current || queuedCount > 0 || deniedMounting)
			this.showStatus("Pending approval cancelled (run ended)", "warning");
	}

	private async getJobRows() {
		if (this.jobRowsCache && Date.now() - this.jobRowsCache.at < JOB_ROWS_CACHE_MS) return this.jobRowsCache.rows;
		const rows = await readJobRows(process.cwd());
		this.jobRowsCache = { at: Date.now(), rows };
		return rows;
	}

	private refreshFooter(): void {
		if (this.footerInFlight) {
			this.footerDirty = true;
			return;
		}
		this.footerInFlight = true;
		void (async () => {
			const sessionId = this.kernel.sessionId;
			const estimate = this.kernel.contextTokens();
			const window = this.kernel.contextWindow;
			const pct = contextPctOf(estimate, window);
			const mobaiDir = sessionMobaiDir(process.cwd(), this.kernel.sessionId);
			const program = await loadProgram(mobaiDir);
			// A refresh that straddled a session switch must not resurrect the old session's mobai snapshot
			if (sessionIdentityChanged(sessionId, this.kernel.sessionId)) return;
			let mobaiBadge: FooterData["mobai"] | undefined;
			if (program) {
				const paused = await isMobaiPaused(mobaiDir);
				if (sessionIdentityChanged(sessionId, this.kernel.sessionId)) return;
				this.mobaiActive = program.status === "active" && !paused;
				this.mobaiStateSnapshot = {
					status: program.status,
					kind: "program",
					objective: program.objective,
					paused,
				};
				if (program.status !== "complete") {
					// startedAt is creation-time (updatedAt rewrites every round); pre-field ledgers fall back
					const startedAt = program.startedAt ?? program.journal[0]?.at ?? program.updatedAt;
					mobaiBadge = {
						objective: program.objective,
						status: paused ? "paused" : program.status,
						elapsedMs: Math.max(0, Date.now() - startedAt),
					};
				}
			} else {
				const mobai = await loadMobaiIn(mobaiDir);
				const legacyPaused = await isMobaiPaused(mobaiDir);
				if (sessionIdentityChanged(sessionId, this.kernel.sessionId)) return;
				this.mobaiActive = mobai?.status === "active" && !legacyPaused;
				this.mobaiStateSnapshot = {
					status: mobai?.status,
					kind: mobai ? "mobai" : undefined,
					objective: mobai?.objective,
					paused: legacyPaused,
				};
				mobaiBadge =
					mobai && mobai.status === "active"
						? {
								objective: mobai.objective,
								status: legacyPaused ? "paused" : mobai.status,
								elapsedMs: Math.max(0, Date.now() - (mobai.startedAt ?? mobai.updatedAt)),
							}
						: undefined;
			}
			const rows = await this.getJobRows();
			if (sessionIdentityChanged(sessionId, this.kernel.sessionId)) return;
			const data: FooterData = {
				modelSpec: `${this.kernel.model.provider}/${this.kernel.model.id}`,
				sessionId: this.kernel.sessionId,
				permissionMode: this.kernel.permissionMode,
				planMode: this.kernel.planMode,
				contextPct: pct,
				contextTokens: estimate,
				contextWindow: window,
				mobai: mobaiBadge,
				runningJobs: rows.filter((r) => r.state === "running" || r.state === "queued").length,
				awaitingJobs: rows.filter((r) => r.state === "awaiting_human").length,
				steerQueued: this.state.steerQueue.length,
			};
			this.footerView.setData(data, this.styles, this.terminal.columns);
			this.tui.requestRender();
		})()
			.catch(() => {})
			.finally(() => {
				this.footerInFlight = false;
				if (this.footerDirty) {
					this.footerDirty = false;
					this.refreshFooter();
				}
			});
	}

	private startFooterTicker(): void {
		const timer = setInterval(() => {
			const active =
				this.kernel.agent.state.isStreaming ||
				this.state.steerQueue.length > 0 ||
				this.mobaiActive ||
				(this.jobRowsCache?.rows.some(
					(r) => r.state === "running" || r.state === "queued" || r.state === "awaiting_human",
				) ??
					false);
			if (active) this.refreshFooter();
		}, FOOTER_TICK_MS);
		timer.unref?.();
		this.disposables.push(() => clearInterval(timer));
	}

	private startJobWatcher(): void {
		// The watcher emits only settled states; awaiting_human surfaces via the footer count and /tasks, not here.
		const watcher = this.kernel.watchJobs((event) => {
			this.jobRowsCache = undefined;
			const mark = event.state === "completed" ? this.styles.success(SUCCESS_MARK) : this.styles.error(FAILURE_MARK);
			this.addText(
				`${mark} job ${event.jobId.slice(0, 8)} → ${event.state}${event.label ? ` (${event.label})` : ""} · /tasks to view`,
			);
			this.notifier.notify("run-complete", `job ${event.jobId.slice(0, 8)} ${event.state}`);
			if (this.tasksPanel) {
				void readJobRows(process.cwd()).then((rows) => {
					this.tasksPanel?.setRows(rows);
					this.tui.requestRender();
				});
			}
			this.refreshFooter();
		});
		this.disposables.push(() => watcher.stop());
	}

	private async mountWelcome(): Promise<void> {
		const statuses = this.kernel.mcpStatuses();
		const mcpSummary =
			statuses.length > 0
				? `${statuses.length} servers · ${statuses.reduce((n, s) => n + (s.connected ? s.tools : 0), 0)} tools`
				: undefined;
		let noCredentials = false;
		try {
			noCredentials = (await listAvailableModels(this.kernel.models)).length === 0;
		} catch {
			noCredentials = false;
		}
		this.ctx.trackComponent(
			new WelcomeComponent(
				{
					version: CORE_VERSION,
					modelSpec: `${this.kernel.model.provider}/${this.kernel.model.id}`,
					sessionId: this.kernel.sessionId,
					cwd: process.cwd(),
					mcpSummary,
					noCredentials,
				},
				this.styles,
			),
		);
	}

	private mountTasksPanel(): void {
		void openTasksPanel(this.ctx).then((panel) => {
			if (!panel) return;
			this.tasksPanel = panel;
			const closePanel = panel.onClose;
			panel.onClose = () => {
				this.tasksPanel = undefined;
				closePanel?.();
			};
		});
	}

	private buildArgumentHints(): Map<string, string> {
		const hints = new Map<string, string>();
		for (const c of BUILTIN_COMMANDS as readonly KeaSlashCommand[]) {
			if (!c.argumentHint) continue;
			hints.set(c.name, c.argumentHint);
			for (const alias of c.aliases) hints.set(alias, c.argumentHint);
		}
		return hints;
	}

	private buildCtx(): TUICtx {
		return {
			tui: this.tui,
			editor: this.editor,
			state: this.state,
			kernel: this.kernel,
			footer: this.footerView,
			todoPanel: this.todoPanel,
			notifier: this.notifier,
			styles: () => this.styles,
			markdownTheme: () => this.markdownTheme,
			addText: (text) => this.addText(text),
			showStatus: (text, tone) => this.showStatus(text, tone),
			showError: (text) => this.showError(text),
			/** Esc while an escalation window is open (agent idle): abort workers + pause mobai, never the TUI */
			interruptEscalation: () => this.interruptEscalation(),
			mountDialog: (component) => this.mountEditorReplacement(component),
			restoreEditor: () => this.restoreEditor(),
			trackComponent: (component: Component) => {
				// WidthSafe global guard: over-wide lines from any component never crash the TUI
				this.transcript.addChild(new WidthSafe(component));
			},
			clearTranscript: () => {
				this.transcript.clear();
				this.state.currentSection = undefined;
				this.state.sectionParts = [];
			},
			trimTranscriptWindow: () => this.trimTranscriptWindow(),
			refreshFooter: () => this.refreshFooter(),
			armExitHint: (kind) => {
				const hint = kind === "ctrl-c" ? "Press Ctrl+C again to exit" : "Press Ctrl+D again to exit";
				this.footerView.setTransientHint(hint, this.styles.warning, EXIT_HINT_TTL_MS);
			},
			resolveApproval: (answer) => {
				const pending = this.state.approval;
				if (!pending) return;
				this.state.approval = undefined;
				pending.close?.();
				pending.resolve(answer);
				this.mountNextApproval();
			},
			// Wrap with streamWithRetry: the idle watchdog guards against a silently hung provider socket.
			summarizeTurn: async (digest: string) => {
				try {
					const stream = streamWithRetry(() =>
						this.kernel.models.streamSimple(this.kernel.model, {
							systemPrompt:
								"You are Kea's UI summarizer. Summarize what the agent did this round in one English sentence of at most 80 characters. Output only the summary itself — no prefix, quotes, or decoration.",
							messages: [{ role: "user", content: [{ type: "text", text: digest }], timestamp: Date.now() }],
						}),
					);
					const result = await stream.result();
					if (result.stopReason === "error") return undefined;
					const text = (
						result.content
							.filter((b): b is { type: "text"; text: string } => b.type === "text")
							.map((b) => b.text)
							.join("")
							.trim()
							.split("\n")[0] ?? ""
					).trim();
					if (text === "") return undefined;
					return text.length > 80 ? `${text.slice(0, 80)}…` : text;
				} catch {
					return undefined;
				}
			},
			exit: () => this.exit(),
		};
	}

	private buildHost(): SlashCommandHost {
		return {
			cwd: process.cwd(),
			isStreaming: () => this.kernel.agent.state.isStreaming,
			isCompacting: () => this.kernel.isCompacting(),
			showStatus: (text) => this.showStatus(text, "dim"),
			showError: (text) => this.showError(text),
			showNotice: (title, detail) => this.showNotice(title, detail),
			lastAssistantText: () => this.state.lastAssistant,
			copyToClipboard: (text) => {
				if (!process.stdout.isTTY) return false;
				const b64 = Buffer.from(text, "utf-8").toString("base64");
				process.stdout.write(`\x1b]52;c;${b64}\x07`);
				return true;
			},
			submitPrompt: (text, opts) =>
				this.sendPrompt(text, { display: opts?.display ?? "bubble", echo: opts?.echo, rearm: opts?.rearm }),
			onMobaiPaused: () => {
				this.invalidateAutoContinue();
				this.refreshFooter();
			},
			onMobaiResumed: () => {
				this.refreshFooter();
				// /mobai resume bypasses sendPrompt: rebase to journal-max before igniting so the first
				// resumed round never collides with historical round numbers.
				void this.rebaseAutoRoundsNow().then(() => this.maybeAutoContinueProgram());
			},
			onMobaiLedgerChanged: () => this.refreshFooter(),
			onMobaiCompleted: (objective) => {
				this.showStatus(`Mobai complete — ${objective.slice(0, 60)} (✓)`, "success");
				void this.advanceMobaiQueue(sessionMobaiDir(process.cwd(), this.kernel.sessionId));
			},
			openModelPicker: () => openModelPicker(this.ctx),
			openProviderManager: () => openProviderManager(this.ctx),
			runAddProviderFlow: (customDirect) => runAddProviderFlow(this.ctx, { customDirect: customDirect === true }),
			openSessionsPicker: () => openSessionsPicker(this.ctx),
			openUndoSelector: (choices, onPick) => openUndoSelector(this.ctx, choices, onPick),
			openPermissionPicker: () => openPermissionPicker(this.ctx),
			openTasksPanel: () => this.mountTasksPanel(),
			openSettingsPanel: () => openSettingsPanel(this.ctx),
			openEffortPicker: () => openEffortPicker(this.ctx),
			openInfoPanel: (title, lines) => openInfoPanel(this.ctx, title, lines),
			openHelpPanel: () => {
				const panel = new HelpPanel(
					this.styles,
					KEY_BINDINGS,
					sortCommands(BUILTIN_COMMANDS as readonly KeaSlashCommand[]),
					{ onClose: () => this.restoreEditor() },
				);
				this.mountEditorReplacement(panel, "help");
			},
			exit: () => this.exit(),
		};
	}
}

export function runTui(kernel: Kernel, options: TuiOptions = {}): Promise<void> {
	new KeaTUI(kernel, options).start();
	return new Promise(() => {});
}
