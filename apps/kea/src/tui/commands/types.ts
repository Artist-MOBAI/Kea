import type { AutocompleteItem, SlashCommand } from "@earendil-works/pi-tui";

export type CommandAvailability = "always" | "idle-only";

export interface KeaSlashCommand extends SlashCommand {
	readonly name: string;
	readonly aliases: readonly string[];
	readonly description: string;

	readonly priority?: number;

	readonly availability?: CommandAvailability | ((args: string) => CommandAvailability);

	readonly completeArgs?: (argumentPrefix: string) => AutocompleteItem[] | null;
}

export interface ParsedSlashInput {
	readonly name: string;
	readonly args: string;
}

export type SlashCommandBusyReason = "streaming" | "compacting";

export type CommandIntent =
	| { kind: "not-command" }
	| { kind: "builtin"; command: KeaSlashCommand; name: string; args: string }
	| { kind: "blocked"; commandName: string; reason: SlashCommandBusyReason }
	| { kind: "invalid"; commandName: string; suggestion?: string };

/** TUI host capability interface: dispatch/handlers consume UI and kernel capabilities; components never touch it. */
export interface SlashCommandHost {
	cwd: string;
	isStreaming(): boolean;
	isCompacting(): boolean;
	showStatus(text: string): void;
	showError(text: string): void;
	showNotice(title: string, detail?: string): void;

	lastAssistantText(): string;
	copyToClipboard(text: string): boolean;
	/** Submit a message as the user. opts.display="system" marks harness-composed text (renders as a
	 *  dim continuation header, never a user bubble); opts.echo overrides both render paths with the
	 *  user's typed command line while the model still receives `text` verbatim (display ≠ sent);
	 *  opts.rearm=false keeps settle state and round counters (harness continuations, not manual input). */
	submitPrompt(text: string, opts?: { display?: "bubble" | "system"; echo?: string; rearm?: boolean }): void;
	/** /mobai pause: invalidate any in-flight/pending auto-continue (a paused mobai must not claim rounds). */
	onMobaiPaused?(): void;

	/** /mobai resume: ignite the next round through the scheduler path (single-focus prompt, no user bubble). */
	onMobaiResumed?(): void;

	/** Any control command that mutated the mobai ledger/paused marker — refresh the footer snapshot so
	 *  the state reminder never injects stale active/paused text into the next request. */
	onMobaiLedgerChanged?(): void;

	/** Legacy /mobai check machine-verified completion — announce and continue the queue. */
	onMobaiCompleted?(objective: string): void;

	openModelPicker(): void;

	openProviderManager(): void;

	/** customDirect=true (/model add) skips the first-level selection and goes straight to the custom endpoint path. */
	runAddProviderFlow(customDirect?: boolean): void;

	openSessionsPicker(): void;

	openUndoSelector(choices: Array<{ value: string; label: string }>, onPick: (value: string) => void): void;

	openPermissionPicker(): void;

	openTasksPanel(): void;

	openHelpPanel(): void;

	openSettingsPanel(): void;

	openEffortPicker(): void;

	openInfoPanel(title: string, lines: string[]): void;

	exit(): void;
}
