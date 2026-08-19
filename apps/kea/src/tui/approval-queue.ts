// Approval request queue: parallel tool calls arrive at approvalHandler concurrently, each awaiting
// its own promise inside the kernel, while there is only one panel slot — first arrival is shown,
// the rest queue and mount in order. Queued entries must never be silently dropped, or the
// kernel-side await hangs forever.
export interface QueuedApproval {
	mount: () => void;
	resolve: (answer: "approve" | "deny") => void;
}

export class ApprovalQueue {
	private readonly entries: QueuedApproval[] = [];

	enqueue(entry: QueuedApproval): void {
		this.entries.push(entry);
	}

	shiftNext(): QueuedApproval | undefined {
		return this.entries.shift();
	}

	/** On run end/abort: settle all queued-but-not-shown entries as deny, returning how many were settled. */
	denyAll(): number {
		const drained = this.entries.splice(0);
		for (const entry of drained) entry.resolve("deny");
		return drained.length;
	}
}
