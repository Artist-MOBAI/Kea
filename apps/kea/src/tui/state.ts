import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ApprovalDecision as KernelApprovalDecision } from "@kea/core";
import type { AssistantMessageView } from "./components/messages/assistant-message.ts";
import type { RoundSection } from "./components/messages/round-section.ts";
import type { SectionToolPart } from "./components/messages/section-card.ts";
import type { ToolCallView } from "./components/messages/tool-call.ts";

export type ApprovalDecision = { kind: "approve" } | { kind: "approve-session" } | { kind: "deny"; feedback?: string };

export interface PendingApproval {
	resolve: (answer: KernelApprovalDecision) => void;
	toolName: string;
	command?: string;
	path?: string;
	danger?: string;
	close?: () => void;
}

/** Single UI state record: all mutable state lives here; components keep only render state. */
export interface TUIState {
	streaming?: AssistantMessageView;
	streamingMessage?: AgentMessage;
	lastAssistant: string;
	toolViews: Map<string, ToolCallView>;
	expanded: boolean;
	exitArmedAt: number;
	/** Which key armed the exit ladder — the double-press confirmation must be the SAME key. */
	exitArmedKey?: "ctrl-c" | "ctrl-d";
	steerQueue: string[];
	approval?: PendingApproval;
	/** Dialog currently occupying the editor slot; while open, Esc goes to the dialog, not the run. */
	activeDialog?: string;
	currentSection?: RoundSection;
	sectionParts: SectionToolPart[];
	sectionStartedAt: number;
}

export function createTUIState(): TUIState {
	return {
		lastAssistant: "",
		toolViews: new Map(),
		expanded: false,
		exitArmedAt: 0,
		steerQueue: [],
		sectionParts: [],
		sectionStartedAt: 0,
	};
}
