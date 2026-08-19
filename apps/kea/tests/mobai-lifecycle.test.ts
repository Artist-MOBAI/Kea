import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
	frontQueue,
	loadQueue,
	pauseMobai,
	resumeMobai,
	saveQueue,
	shiftQueue,
	unshiftQueue,
} from "../src/tui/mobai-lifecycle.ts";

let workdir: string;

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

async function freshMobaiDir(): Promise<string> {
	workdir = await mkdtemp(join(tmpdir(), "kea2-mobailife-"));
	return join(workdir, "mobai", "session-x");
}

describe("mobai lifecycle UX state (paused marker + queue)", () => {
	test("pause/resume markers are idempotent and detectable", async () => {
		const dir = await freshMobaiDir();
		expect(await pauseMobai(dir)).toBe(true);
		expect(await pauseMobai(dir)).toBe(false);
		expect(await resumeMobai(dir)).toBe(true);
		expect(await resumeMobai(dir)).toBe(false);
	});

	test("queue: push/list/shift keep order; a corrupted file falls back to empty", async () => {
		const dir = await freshMobaiDir();
		expect(await loadQueue(dir)).toEqual([]);
		await saveQueue(dir, ["first objective", "second objective"]);
		expect(await loadQueue(dir)).toEqual(["first objective", "second objective"]);
		expect(await shiftQueue(dir)).toBe("first objective");
		expect(await loadQueue(dir)).toEqual(["second objective"]);
		expect(await shiftQueue(dir)).toBe("second objective");
		expect(await shiftQueue(dir)).toBeUndefined();
		// corrupted queue file must not break the surface
		await Bun.write(join(dir, "queue.json"), "{not json");
		expect(await loadQueue(dir)).toEqual([]);
	});

	test("front/unshift: peek does not remove; a failed submission rolls the head back to the front (T9)", async () => {
		const dir = await freshMobaiDir();
		await saveQueue(dir, ["first objective", "second objective"]);
		// peek leaves the queue intact
		expect(await frontQueue(dir)).toBe("first objective");
		expect(await loadQueue(dir)).toEqual(["first objective", "second objective"]);
		// the rollback path: a consumed head whose submission failed goes back to the FRONT
		const head = await shiftQueue(dir);
		expect(head).toBe("first objective");
		await unshiftQueue(dir, head as string);
		expect(await loadQueue(dir)).toEqual(["first objective", "second objective"]);
		// an interleaved push during the failure window must not reorder the restored head
		await saveQueue(dir, ["third objective"]);
		await unshiftQueue(dir, "first objective");
		expect(await loadQueue(dir)).toEqual(["first objective", "third objective"]);
		// empty queue: unshift still works
		await saveQueue(dir, []);
		await unshiftQueue(dir, "revived objective");
		expect(await loadQueue(dir)).toEqual(["revived objective"]);
	});
});
