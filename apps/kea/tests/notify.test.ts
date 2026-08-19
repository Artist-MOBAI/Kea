import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createNotifier } from "../src/tui/notify.ts";

const saved = {
	NO_COLOR: process.env.NO_COLOR,
	TERM_PROGRAM: process.env.TERM_PROGRAM,
	TERM: process.env.TERM,
};

beforeEach(() => {
	delete process.env.NO_COLOR;
});

afterAll(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("notifier (M2)", () => {
	test("non-TTY output stays silent", () => {
		let written = "";
		const fake = { isTTY: false, write: (s: string) => (written += s) } as unknown as NodeJS.WriteStream;
		createNotifier(fake).notify("run-complete", "done");
		expect(written).toBe("");
	});

	test("NO_COLOR silences notifications even on a TTY", () => {
		process.env.NO_COLOR = "1";
		let written = "";
		const fake = { isTTY: true, write: (s: string) => (written += s) } as unknown as NodeJS.WriteStream;
		createNotifier(fake).notify("run-complete", "done");
		expect(written).toBe("");
	});

	test("OSC 9 capable terminal gets an OSC 9 sequence", () => {
		let written = "";
		const fake = { isTTY: true, write: (s: string) => (written += s) } as unknown as NodeJS.WriteStream;
		process.env.TERM_PROGRAM = "iTerm.app";
		createNotifier(fake).notify("approval-requested", "bash needs approval");
		expect(written).toContain("\x1b]9;");
		expect(written).toContain("Kea needs approval");
	});

	test("unsupported TTY falls back to BEL", () => {
		let written = "";
		const fake = { isTTY: true, write: (s: string) => (written += s) } as unknown as NodeJS.WriteStream;
		process.env.TERM_PROGRAM = "";
		process.env.TERM = "vt100";
		createNotifier(fake).notify("run-complete", "done");
		expect(written).toBe("\x07");
	});
});
