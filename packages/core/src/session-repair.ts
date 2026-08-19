import type { Message } from "@earendil-works/pi-ai";

// abort can interrupt a tool batch: an assistant message carries N toolCalls while the ledger only stored M<N
// toolResults, and providers require every tool_use to have a paired tool_result. Synthesize error results for
// dangling toolCalls before sending to the LLM — valid transcript, semantically honest (the tool really did not finish).
export function repairToolCallPairing(messages: readonly Message[]): Message[] {
	const out: Message[] = [];
	const pending = new Map<string, { id: string; name: string }>();

	const flush = (timestamp: number): void => {
		for (const call of pending.values()) {
			out.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: `Tool call "${call.name}" was interrupted before completion.` }],
				isError: true,
				timestamp,
			});
		}
		pending.clear();
	};

	for (const message of messages) {
		if (message.role === "assistant") {
			if (pending.size > 0) flush(message.timestamp);
			for (const block of message.content) {
				if (block.type === "toolCall") {
					pending.set(block.id, { id: block.id, name: block.name });
				}
			}
		} else if (message.role === "toolResult") {
			// an empty toolCallId cannot be paired: skip it
			if (message.toolCallId) pending.delete(message.toolCallId);
		} else if (pending.size > 0) {
			// dangling calls must be flushed before a user/other-role message appears
			flush(message.timestamp);
		}
		out.push(message);
	}
	if (pending.size > 0) flush(Date.now());
	return out;
}
