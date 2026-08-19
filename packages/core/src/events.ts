import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PermissionMode } from "./permission.ts";

export type RunOutcome = "completed" | "aborted" | "failed";

export type KernelEvent =
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_delta"; message: AgentMessage; text: string; thinking?: string }
	| { type: "message_end"; message: AgentMessage; text: string; thinking?: string }
	| { type: "tool_start"; toolCallId: string; name: string; args: unknown }
	| { type: "tool_update"; toolCallId: string; name: string; partial: unknown }
	| {
			type: "tool_end";
			toolCallId: string;
			name: string;
			isError: boolean;
			durationMs: number;
			resultPreview: string;
			details?: unknown;
	  }
	| { type: "run_start"; runId: string }
	| { type: "run_end"; runId: string; outcome: RunOutcome; error?: string }
	| { type: "compaction_started" }
	| { type: "compaction_applied"; tokensBefore?: number; tokensAfter?: number }
	| { type: "compaction_failed"; reason?: string }
	| { type: "model_retry"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "session_switched"; sessionId: string }
	| { type: "permission_mode_changed"; mode: PermissionMode }
	| { type: "plan_mode_changed"; on: boolean }
	| { type: "science_mode_changed"; on: boolean };

export type KernelEventListener = (event: KernelEvent) => void;

export class KernelEventBus {
	private listeners = new Set<KernelEventListener>();

	subscribe(listener: KernelEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	emit(event: KernelEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (err) {
				console.error("[kea] event listener error:", err);
			}
		}
	}
}
