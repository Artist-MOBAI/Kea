import { describe, expect, test } from "vitest";
import {
	describeTool,
	describeToolDone,
	firstSentence,
	mechanicalSummary,
} from "../src/tui/components/messages/caption-text.ts";

describe("describeTool (kimi dual form: Running a command / Using {tool} (keyArg))", () => {
	test("bash has no keyArg; other tools get Using {toolName} (keyArg)", () => {
		expect(describeTool("bash", { command: "echo ok" })).toBe("Running a command");
		expect(describeTool("read", { path: "skills/x/SKILL.md" })).toBe("Using read (skills/x/SKILL.md)");
		expect(describeTool("write", { path: "/tmp/a.txt" })).toBe("Using write (/tmp/a.txt)");
		expect(describeTool("edit", { path: "src/b.ts" })).toBe("Using edit (src/b.ts)");
		expect(describeTool("grep", { pattern: "METRIC" })).toBe("Using grep (METRIC)");
		expect(describeTool("glob", { pattern: "**/*.ts" })).toBe("Using glob (**/*.ts)");
		expect(describeTool("fetch_url", { url: "https://example.com/a" })).toBe("Using fetch_url (https://example.com/a)");
		expect(describeTool("web_search", { query: "perovskite stability" })).toBe(
			"Using web_search (perovskite stability)",
		);
		expect(describeTool("spawn_agent", { task: "scan papers for Tc data" })).toBe(
			"Using spawn_agent (scan papers for Tc data)",
		);
	});

	test("unknown tools fall back to the first string param (first line); no keyArg means no parens", () => {
		expect(describeTool("journal_note", { note: "line one\nline two" })).toBe("Using journal_note (line one)");
		expect(describeTool("glob", {})).toBe("Using glob");
		expect(describeTool("check_goal", {})).toBe("Using check_goal");
	});

	test("path keyArg: overlong values truncate keeping the tail (…/name.ext, cap 60)", () => {
		const long = `/${"x".repeat(120)}/f.txt`;
		const text = describeTool("read", { path: long });
		const keyArg = text.slice("Using read (".length, -1);
		expect(keyArg.length).toBeLessThanOrEqual(60);
		expect(keyArg.startsWith("…")).toBe(true);
		expect(keyArg.endsWith("/f.txt")).toBe(true);
	});
});

describe("firstSentence (streaming first sentence)", () => {
	test("extracts the first sentence and truncates", () => {
		// cjk-fixture: exercises CJK full-stop sentence splitting and newline handling
		expect(firstSentence("我先读方法论。然后建目录。")).toBe("我先读方法论。");
		expect(firstSentence("无句号的开头\n第二行")).toBe("无句号的开头");
		expect(firstSentence("。".repeat(1) + "x".repeat(100), 20).length).toBeLessThanOrEqual(21);
	});
});

describe("mechanicalSummary (end-of-turn mechanical sentence, fallback for the AI summary)", () => {
	const part = (toolName: string, preview = "") => ({ toolName, durationMs: 10, isError: false, preview });

	test("aggregates action kinds into natural language", () => {
		const text = mechanicalSummary([part("read"), part("read"), part("bash"), part("write")], 24_000);
		expect(text).toBe("read 2 files, ran 1 command, wrote 1 file (24s)");
	});

	test("METRIC line appended", () => {
		const text = mechanicalSummary([part("run_experiment", "METRIC tour_length=421")], 5_000);
		expect(text).toContain("metric tour_length=421");
	});

	test("empty turn degrades to a placeholder", () => {
		expect(mechanicalSummary([], 1000)).toBe("No tools used (1s)");
	});
});

describe("describeToolDone (kimi dual-form completion: Ran a command / Used {tool} (keyArg))", () => {
	test("path made workspace-relative + milliseconds + line count", () => {
		expect(describeToolDone("read", { path: "/proj/src/a.ts" }, 12, "l1\nl2\nl3", false, "/proj")).toBe(
			"Used read (src/a.ts) · 12ms · 3 lines",
		);
	});

	test("bash has no keyArg; ≥1s shows seconds; errors flagged; empty preview omits line count", () => {
		expect(describeToolDone("bash", {}, 5000, "out", false, "/proj")).toBe("Ran a command · 5.0s · 1 line");
		expect(describeToolDone("bash", {}, 900, "", true, "/proj")).toBe("Ran a command · 900ms · failed");
		expect(describeToolDone("glob", {}, 5, "", false, "/proj")).toBe("Used glob · 5ms");
	});

	test("research tools keep the tool name; missing params degrade without parens", () => {
		expect(describeToolDone("check_novelty", {}, 200, "known", false, "/proj")).toBe(
			"Used check_novelty · 200ms · 1 line",
		);
		expect(describeToolDone("read", {}, 10, "", false, "/proj")).toBe("Used read · 10ms");
	});

	test("long paths get the same tail-keeping truncation on completion", () => {
		const long = `/proj/${"y".repeat(120)}/deep/name.ext`;
		const text = describeToolDone("write", { path: long }, 8, "", false, "/proj");
		const keyArg = text.slice("Used write (".length, text.indexOf(") ·"));
		expect(keyArg.length).toBeLessThanOrEqual(60);
		expect(keyArg.endsWith("/deep/name.ext")).toBe(true);
	});
});
