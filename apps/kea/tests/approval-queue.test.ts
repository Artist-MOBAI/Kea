import { describe, expect, test } from "vitest";
import { closeWithWatchdog, shouldMountNextApproval } from "../src/tui/app.ts";
import { ApprovalQueue } from "../src/tui/approval-queue.ts";

// concurrent tool calls reach approvalHandler in parallel, but the panel has a single slot;
// a lost resolve hangs the kernel-internal await forever. The harness mimics app-side wiring.
function makeApprovalHarness() {
	const queue = new ApprovalQueue();
	const mounted: number[] = [];
	let slot: { resolve: (answer: "approve" | "deny") => void } | undefined;
	const mountNext = () => {
		const next = queue.shiftNext();
		if (!next) return;
		slot = { resolve: next.resolve };
		next.mount();
	};
	const handleApproval = (id: number) =>
		new Promise<"approve" | "deny">((resolve) => {
			queue.enqueue({ mount: () => mounted.push(id), resolve });
			if (slot === undefined) mountNext();
		});
	const decideShown = (answer: "approve" | "deny") => {
		const current = slot;
		slot = undefined;
		current?.resolve(answer);
		mountNext();
	};
	const denyRunEnd = () => {
		const drained = queue.denyAll();
		const current = slot;
		slot = undefined;
		current?.resolve("deny");
		return drained;
	};
	return { queue, mounted, handleApproval, decideShown, denyRunEnd };
}

describe("ApprovalQueue (concurrent approvals never lose a resolve)", () => {
	test("first request mounts, concurrent second queues; next mounts in order after a decision", async () => {
		const { mounted, handleApproval, decideShown } = makeApprovalHarness();
		const p1 = handleApproval(1);
		const p2 = handleApproval(2);
		expect(mounted).toEqual([1]);

		decideShown("approve");
		expect(await p1).toBe("approve");
		expect(mounted).toEqual([1, 2]);

		decideShown("deny");
		expect(await p2).toBe("deny");
	});

	test("run end: both the shown and the queued settle as deny, no dangling await", async () => {
		const { handleApproval, denyRunEnd } = makeApprovalHarness();
		const p1 = handleApproval(1);
		const p2 = handleApproval(2);
		const p3 = handleApproval(3);

		expect(denyRunEnd()).toBe(2);
		expect([await p1, await p2, await p3]).toEqual(["deny", "deny", "deny"]);
	});

	test("denyAll on an empty queue returns 0", () => {
		expect(new ApprovalQueue().denyAll()).toBe(0);
	});
});

// buildApprovalPreview is async: between "shifted from the queue" and "panel holds the slot" there is
// a window where state.approval is still undefined — the mount gate must consider BOTH slots.
function makeAsyncMountHarness() {
	const queue = new ApprovalQueue();
	const mounted: number[] = [];
	const shown: number[] = [];
	// deferred preview builds per request id: mount waits for the release before taking the slot
	const pendingPreviews = new Map<number, () => void>();
	// requests settled by denyRunEnd while their preview was still building (their .then must no-op)
	const deniedWhileMounting = new Set<number>();
	let slot: { resolve: (answer: "approve" | "deny") => void } | undefined;
	let mounting: { id: number; resolve: (answer: "approve" | "deny") => void } | undefined;

	const mountNext = () => {
		if (!shouldMountNextApproval(slot !== undefined, mounting !== undefined)) return;
		const next = queue.shiftNext();
		if (!next) return;
		next.mount();
	};

	return {
		mounted,
		shown,
		handleApproval: (id: number) =>
			new Promise<"approve" | "deny">((resolve) => {
				queue.enqueue({
					mount: () => {
						mounted.push(id);
						mounting = { id, resolve };
						void new Promise<void>((release) => pendingPreviews.set(id, release)).then(() => {
							pendingPreviews.delete(id);
							mounting = undefined;
							if (deniedWhileMounting.has(id)) return; // already settled as deny
							slot = { resolve };
							shown.push(id);
							mountNext(); // no-op while the slot is held
						});
					},
					resolve,
				});
				mountNext();
			}),
		finishPreview: (id: number) => pendingPreviews.get(id)?.(),
		decideShown: (answer: "approve" | "deny") => {
			const current = slot;
			slot = undefined;
			current?.resolve(answer);
			mountNext();
		},
		denyRunEnd: () => {
			const drained = queue.denyAll();
			const current = slot;
			slot = undefined;
			current?.resolve("deny");
			// a request mid-preview-build is outside the queue and the slot — settle it too
			// or its kernel-side await would hang forever
			if (mounting !== undefined) {
				deniedWhileMounting.add(mounting.id);
				mounting.resolve("deny");
				mounting = undefined;
			}
			return drained;
		},
	};
}

describe("async preview window of concurrent approvals (F1 regression)", () => {
	// flush pending .then callbacks (preview completion settles on a microtask)
	const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

	test("second does not mount while the first preview builds; then mounts in order, resolved exactly once", async () => {
		const h = makeAsyncMountHarness();
		const p1 = h.handleApproval(1);
		const p2 = h.handleApproval(2);
		// 1 is mounting (preview pending): 2 must stay queued, not steal the mounting slot
		expect(h.mounted).toEqual([1]);

		h.finishPreview(1);
		await flush();
		expect(h.shown).toEqual([1]);
		expect(h.mounted).toEqual([1]);

		h.decideShown("approve");
		expect(await p1).toBe("approve");
		expect(h.mounted).toEqual([1, 2]);

		h.finishPreview(2);
		await flush();
		h.decideShown("deny");
		expect(await p2).toBe("deny");
	});

	test("run end mid preview build: all deny, none left hanging", async () => {
		const h = makeAsyncMountHarness();
		const p1 = h.handleApproval(1);
		const p2 = h.handleApproval(2);

		expect(h.denyRunEnd()).toBe(1); // 2 was still queued (1 was mid-build, outside the queue)
		await flush();
		expect(await p1).toBe("deny");
		expect(await p2).toBe("deny");
	});
});

describe("shouldMountNextApproval (single-flight gate truth table)", () => {
	test("mount allowed only when no panel is shown and no preview is building", () => {
		expect(shouldMountNextApproval(false, false)).toBe(true);
		expect(shouldMountNextApproval(true, false)).toBe(false);
		expect(shouldMountNextApproval(false, true)).toBe(false);
		expect(shouldMountNextApproval(true, true)).toBe(false);
	});
});

describe("closeWithWatchdog (exit watchdog: kernel.close gets a window, exit never hangs)", () => {
	test("close completes promptly → true", async () => {
		const order: string[] = [];
		const ok = await closeWithWatchdog(async () => {
			order.push("close");
		}, 500);
		expect(ok).toBe(true);
		expect(order).toEqual(["close"]);
	});

	test("close hangs → watchdog times out and returns false, no infinite wait", async () => {
		const started = Date.now();
		const ok = await closeWithWatchdog(() => new Promise<void>(() => {}), 80);
		expect(ok).toBe(false);
		expect(Date.now() - started).toBeGreaterThanOrEqual(70);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	test("close throws → false (never rejects)", async () => {
		const ok = await closeWithWatchdog(async () => {
			throw new Error("mcp shutdown failed");
		}, 500);
		expect(ok).toBe(false);
	});
});
