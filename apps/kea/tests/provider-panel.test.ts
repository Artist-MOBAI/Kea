import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { ProviderPanel, type ProviderRow } from "../src/tui/components/dialogs/provider-panel.ts";
import { CURRENT_MARK, FAILURE_MARK, SELECT_POINTER, SUCCESS_MARK } from "../src/tui/constants/symbols.ts";
import { identityStyles } from "./helpers/styles.ts";

const ROWS: ProviderRow[] = [
	{
		id: "anthropic",
		source: "ANTHROPIC_API_KEY",
		kind: "builtin",
		isCurrent: true,
		deletable: false,
		modelCount: 3,
		models: [
			{ id: "claude-sonnet-4-5", contextWindow: 200000 },
			{ id: "claude-opus-4-8", contextWindow: 200000 },
			{ id: "claude-haiku-4-5", contextWindow: 200000 },
		],
		connectionStatus: "verified",
	},
	{
		id: "mylab",
		source: "stored key",
		baseUrl: "https://api.mylab.ai/v1",
		kind: "custom",
		isCurrent: false,
		deletable: true,
		modelCount: 1,
		models: [{ id: "researcher-72b", contextWindow: 131072 }],
	},
];

function makePanel(rows: ProviderRow[]) {
	const calls: {
		add: number;
		deleted: ProviderRow[];
		closed: number;
		testConnection: ProviderRow[];
		editBaseUrl: ProviderRow[];
	} = {
		add: 0,
		deleted: [],
		closed: 0,
		testConnection: [],
		editBaseUrl: [],
	};
	const panel = new ProviderPanel(rows, identityStyles(), {
		onAdd: () => (calls.add += 1),
		onDelete: (row) => calls.deleted.push(row),
		onClose: () => (calls.closed += 1),
		onTestConnection: (row) => calls.testConnection.push(row),
		onEditBaseUrl: (row) => calls.editBaseUrl.push(row),
	});
	return { panel, calls };
}

describe("ProviderPanel list view", () => {
	test("rows show id, source label, dim baseUrl, model count, and current mark; Add row last", () => {
		const { panel } = makePanel(ROWS);
		const lines = panel.render(100).map((l) => stripTerminalSequences(l));
		const joined = lines.join("\n");
		expect(joined).toContain("Providers & credentials");
		expect(joined).toContain("anthropic");
		expect(joined).toContain("ANTHROPIC_API_KEY");
		expect(joined).toContain(CURRENT_MARK);
		expect(joined).toContain("mylab");
		expect(joined).toContain("stored key");
		expect(joined).toContain("https://api.mylab.ai/v1");
		expect(joined).toContain("[ Add new provider ]");
		expect(joined).toContain("3 models");
		expect(joined).toContain("1 model");
		expect(lines.filter((l) => l.includes(SELECT_POINTER))).toHaveLength(1);
	});

	test("empty state copy is shown with the Add row", () => {
		const { panel } = makePanel([]);
		const joined = panel
			.render(100)
			.map((l) => stripTerminalSequences(l))
			.join("\n");
		expect(joined).toContain("No providers configured — press Enter to add one, or export *_API_KEY.");
		expect(joined).toContain("[ Add new provider ]");
	});

	test("every line fits narrow widths (pi-tui hard-crash guard)", () => {
		const { panel } = makePanel(ROWS);
		for (const width of [12, 20, 40, 80]) {
			for (const line of panel.render(width)) {
				expect(visibleWidth(stripTerminalSequences(line)), `width=${width}`).toBeLessThanOrEqual(width);
			}
		}
		const empty = makePanel([]).panel;
		for (const width of [12, 20, 40]) {
			for (const line of empty.render(width)) {
				expect(visibleWidth(stripTerminalSequences(line)), `width=${width}`).toBeLessThanOrEqual(width);
			}
		}
	});

	test("Enter on a provider row opens the detail view; Enter on Add triggers onAdd", () => {
		const { panel, calls } = makePanel(ROWS);
		panel.handleInput("\r");
		expect(calls.add).toBe(0);
		panel.handleInput("\x1b");
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		expect(calls.add).toBe(1);
	});

	test("D arms inline [y/N] confirm; y deletes, n backs out", () => {
		const { panel, calls } = makePanel(ROWS);
		panel.handleInput("\x1b[B");
		panel.handleInput("D");
		expect(
			panel
				.render(100)
				.map((l) => stripTerminalSequences(l))
				.join("\n"),
		).toContain("Delete mylab? [y/N]");
		panel.handleInput("n");
		expect(calls.deleted).toHaveLength(0);
		expect(
			panel
				.render(100)
				.map((l) => stripTerminalSequences(l))
				.join("\n"),
		).not.toContain("[y/N]");
		panel.handleInput("D");
		panel.handleInput("y");
		expect(calls.deleted.map((r) => r.id)).toEqual(["mylab"]);
	});

	test("D on a non-deletable row (env-only builtin) does nothing", () => {
		const { panel, calls } = makePanel(ROWS);
		panel.handleInput("D");
		expect(
			panel
				.render(100)
				.map((l) => stripTerminalSequences(l))
				.join("\n"),
		).not.toContain("[y/N]");
		panel.handleInput("y");
		expect(calls.deleted).toHaveLength(0);
	});

	test("delete confirm renders on its own line and the [y/N] prompt survives narrow widths", () => {
		const { panel } = makePanel(ROWS);
		panel.handleInput("\x1b[B");
		panel.handleInput("D");
		for (const width of [12, 20, 40]) {
			const lines = panel.render(width).map((l) => stripTerminalSequences(l));
			expect(
				lines.some((l) => l.includes("[y/N]")),
				`width=${width} confirm visible`,
			).toBe(true);
			for (const line of lines) {
				expect(visibleWidth(line), `width=${width}`).toBeLessThanOrEqual(width);
			}
		}
		expect(
			panel
				.render(20)
				.map((l) => stripTerminalSequences(l))
				.join("\n"),
		).toContain("Delete mylab? [y/N]");
		const lines = panel.render(100).map((l) => stripTerminalSequences(l));
		expect(lines[1]).toBe(" Providers & credentials");
	});

	test("setRows keeps the highlight on the same provider id when a row above is deleted", () => {
		const three: ProviderRow[] = [
			{ id: "anthropic", source: "env", kind: "builtin", isCurrent: true, deletable: false, modelCount: 0, models: [] },
			{
				id: "mylab",
				source: "stored key",
				kind: "custom",
				isCurrent: false,
				deletable: true,
				modelCount: 0,
				models: [],
			},
			{
				id: "other",
				source: "stored key",
				kind: "custom",
				isCurrent: false,
				deletable: true,
				modelCount: 0,
				models: [],
			},
		];
		const { panel } = makePanel(three);
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B");
		panel.setRows(three.filter((r) => r.id !== "mylab"));
		const pointerLine = panel
			.render(100)
			.map((l) => stripTerminalSequences(l))
			.find((l) => l.includes(SELECT_POINTER));
		expect(pointerLine).toContain("other");
	});

	test("setRows falls back to clamping when the selected row itself is deleted", () => {
		const { panel } = makePanel(ROWS);
		panel.handleInput("\x1b[B");
		panel.setRows([ROWS[0] as ProviderRow]);
		const pointerLine = panel
			.render(100)
			.map((l) => stripTerminalSequences(l))
			.find((l) => l.includes(SELECT_POINTER));
		expect(pointerLine).toContain("[ Add new provider ]");
	});

	test("Esc closes; setRows clamps selection and clears the confirm state", () => {
		const { panel, calls } = makePanel(ROWS);
		panel.handleInput("\x1b");
		expect(calls.closed).toBe(1);
		panel.handleInput("\x1b[B");
		panel.handleInput("D");
		panel.setRows([ROWS[0] as ProviderRow]);
		const joined = panel
			.render(100)
			.map((l) => stripTerminalSequences(l))
			.join("\n");
		expect(joined).not.toContain("[y/N]");
		expect(joined).not.toContain("mylab");
	});
});

describe("ProviderPanel connection status", () => {
	test("defaults to ? (not tested); setProbeResult reflects the probe outcome", () => {
		const { panel } = makePanel(ROWS);
		const renderText = () =>
			panel
				.render(100)
				.map((l) => stripTerminalSequences(l))
				.join("\n");

		expect(renderText()).toContain(`${SUCCESS_MARK} anthropic`);
		expect(renderText()).toContain(`? mylab`);

		panel.setProbeResult("mylab", "verified");
		expect(renderText()).toContain(`${SUCCESS_MARK} mylab`);
		expect(renderText()).not.toContain(`? mylab`);

		panel.setProbeResult("mylab", "failed");
		expect(renderText()).toContain(`${FAILURE_MARK} mylab`);

		panel.setProbeResult("mylab", undefined);
		expect(renderText()).toContain(`? mylab`);
	});
});

describe("ProviderPanel detail view", () => {
	test("Enter on a provider row opens detail view with info and actions", () => {
		const { panel } = makePanel(ROWS);
		panel.handleInput("\r");
		const joined = panel
			.render(100)
			.map((l) => stripTerminalSequences(l))
			.join("\n");
		expect(joined).toContain("anthropic");
		expect(joined).toContain("[builtin]");
		expect(joined).toContain("Source: ANTHROPIC_API_KEY");
		expect(joined).toContain("Models");
		expect(joined).toContain("claude-sonnet-4-5");
		expect(joined).toContain("Test connection");
		expect(joined).toContain("Esc");
	});

	test("Esc from detail view returns to list view", () => {
		const { panel } = makePanel(ROWS);
		panel.handleInput("\r");
		panel.handleInput("\x1b");
		const joined = panel
			.render(100)
			.map((l) => stripTerminalSequences(l))
			.join("\n");
		expect(joined).toContain("Providers & credentials");
		expect(joined).toContain("[ Add new provider ]");
	});

	test("T key triggers test connection in detail view", () => {
		const { panel, calls } = makePanel(ROWS);
		panel.handleInput("\r");
		panel.handleInput("T");
		expect(calls.testConnection).toHaveLength(1);
		expect(calls.testConnection[0]?.id).toBe("anthropic");
	});

	test("Enter on Test action triggers test connection", () => {
		const { panel, calls } = makePanel(ROWS);
		panel.handleInput("\r");
		panel.handleInput("\r");
		expect(calls.testConnection).toHaveLength(1);
	});

	test("Delete action in detail view sets confirm state and goes back to list", () => {
		const { panel } = makePanel(ROWS);
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		const joined = panel
			.render(100)
			.map((l) => stripTerminalSequences(l))
			.join("\n");
		expect(joined).toContain("[y/N]");
	});

	test("E key triggers edit base URL in detail view for custom provider", () => {
		const { panel, calls } = makePanel(ROWS);
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		panel.handleInput("E");
		expect(calls.editBaseUrl).toHaveLength(1);
		expect(calls.editBaseUrl[0]?.id).toBe("mylab");
	});

	test("up/down navigate detail actions", () => {
		const { panel } = makePanel(ROWS);
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		const firstRender = panel
			.render(100)
			.map((l) => stripTerminalSequences(l))
			.join("\n");
		expect(firstRender).toContain(SELECT_POINTER);
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B");
		const secondRender = panel
			.render(100)
			.map((l) => stripTerminalSequences(l))
			.join("\n");
		expect(secondRender).toContain("Delete");
	});
});
