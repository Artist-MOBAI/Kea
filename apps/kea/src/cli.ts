#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool, JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import {
	asTool,
	createExecutionEnv,
	createKernel,
	createModelsCollection,
	ensureTrustHeadless,
	FileCredentialStore,
	getWorkspaceTrustInfo,
	isFolderTrusted,
	type Kernel,
	MemoryStore,
	planSlug,
	plansDir,
	registerCustomModels,
	resolveModel,
	runDoctor,
	SessionManager,
	type SubagentRunner,
	trustFolder,
} from "@kea/core";
import { createValidateReactionsTool } from "@kea/domain-chemistry";
import { createSearchLiteratureTool } from "@kea/domain-literature";
import { createQueryMaterialTool, queryMaterial } from "@kea/domain-materials";
import { createProgramTools, createResearchTools, Journal, loadProgram, programPathIn } from "@kea/research";
import { loadConfig, projectConfigPath } from "./config.ts";
import { type MobaiReport, runMobaiLoop } from "./headless/mobai.ts";
import { type ProgramReport, runProgramLoop } from "./headless/program.ts";
import { runHeadless } from "./headless/run.ts";
import { runScienceLoop, type ScienceReport } from "./headless/science.ts";
import { closeWithWatchdog, runTui } from "./tui/app.ts";
import { type TrustChoice, TrustPrompt } from "./tui/components/dialogs/trust-prompt.ts";
import { FAILURE_MARK, SUCCESS_MARK } from "./tui/constants/symbols.ts";
import { sessionMobaiDir } from "./tui/mobai-dir.ts";
import { createTheme } from "./tui/theme.ts";
import { acquireSessionLock, releaseAllSessionLocks } from "./tui/utils/session-lock.ts";

interface CliOptions {
	mode: "tui" | "run" | "mobai" | "science" | "doctor";
	model?: string;
	resume?: string;
	prompt?: string;
	format: "text" | "ndjson";
	formatExplicit: boolean;
	maxRounds?: number;
	maxMinutes?: number;
	permission?: "manual" | "auto" | "yolo";
	discipline?: "math" | "metric";
	help: boolean;
}

const USAGE_HINT = "Run `kea --help` for usage.";

function usageError(message: string): never {
	console.error(message);
	console.error(USAGE_HINT);
	process.exit(1);
}

// Headless exits go straight through process.exit — the session lock must not outlive the process.
function releaseSessionLocksBestEffort(): void {
	try {
		releaseAllSessionLocks();
	} catch {}
}

function requireValue(arg: string, next: string | undefined): string {
	if (next === undefined || next.startsWith("-")) usageError(`${arg} requires a value`);
	return next;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = { mode: "tui", format: "text", formatExplicit: false, help: false };
	let i = 0;
	if (argv[0] === "run") {
		options.mode = "run";
		i = 1;
	} else if (argv[0] === "mobai") {
		options.mode = "mobai";
		i = 1;
	} else if (argv[0] === "science") {
		options.mode = "science";
		i = 1;
	} else if (argv[0] === "doctor") {
		options.mode = "doctor";
		i = 1;
	}
	for (; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--model" || arg === "-m") {
			options.model = requireValue(arg, argv[++i]);
		} else if (arg === "--resume") {
			const next = argv[i + 1];
			if (next && !next.startsWith("-")) {
				options.resume = next;
				i += 1;
			} else {
				options.resume = "latest";
			}
		} else if (arg === "--prompt" || arg === "-p") {
			options.prompt = requireValue(arg, argv[++i]);
		} else if (arg === "--format") {
			const next = requireValue(arg, argv[++i]);
			if (next === "text" || next === "ndjson") {
				options.format = next;
				options.formatExplicit = true;
			} else {
				usageError("--format expects text|ndjson");
			}
		} else if (arg === "--max-rounds") {
			const next = Number(requireValue(arg, argv[++i]));
			if (!Number.isInteger(next) || next < 1) {
				usageError("--max-rounds expects a positive integer");
			}
			options.maxRounds = next;
		} else if (arg === "--max-minutes") {
			const next = Number(requireValue(arg, argv[++i]));
			if (!Number.isInteger(next) || next < 1) {
				usageError("--max-minutes expects a positive integer");
			}
			options.maxMinutes = next;
		} else if (arg === "--permission") {
			const next = requireValue(arg, argv[++i]);
			if (next === "manual" || next === "auto" || next === "yolo") {
				options.permission = next;
			} else {
				usageError("--permission expects manual|auto|yolo");
			}
		} else if (arg === "--discipline") {
			const next = requireValue(arg, argv[++i]);
			if (next === "math" || next === "metric") {
				options.discipline = next;
			} else {
				usageError("--discipline expects math|metric");
			}
		} else {
			// unknown args fail loudly — a mistyped flag in CI must not silently succeed
			console.error(`Unknown argument: ${arg}`);
			console.log(HELP);
			process.exit(1);
		}
	}
	return options;
}

function validateModeFlags(options: CliOptions): void {
	if (options.mode === "tui") {
		if (
			options.prompt !== undefined ||
			options.maxRounds !== undefined ||
			options.maxMinutes !== undefined ||
			options.formatExplicit
		) {
			usageError(
				"-p/--prompt, --format, --max-rounds, --max-minutes apply to run/mobai/science modes, not the interactive TUI",
			);
		}
		return;
	}
	if (options.mode === "run") {
		if (options.maxRounds !== undefined || options.maxMinutes !== undefined) {
			usageError("--max-rounds and --max-minutes apply only to mobai/science modes");
		}
		return;
	}
	if ((options.mode === "mobai" || options.mode === "science") && options.formatExplicit) {
		usageError("--format applies only to run mode (mobai/science always emit a JSON report)");
	}
	if (options.discipline !== undefined && options.mode !== "mobai") {
		usageError("--discipline applies only to mobai mode (program formalization vocabulary/acceptance discipline)");
	}
}

const HELP = `kea — scientific discovery agent (Kea-2)

Usage:
  kea [options]                  Interactive TUI
  kea run -p "<task>" [options]  Headless one-shot (scripts/CI)
  kea mobai -p "<objective>"     Unattended mobai loop (machine-verified completion)
  kea mobai                       Continue the existing mobai unattended
  kea science -p "<problem>"     Autonomous science investigation (distill → explore → converge)

Options:
  -m, --model <provider/model-id>  Model to use (env: KEA_MODEL, kea.toml: defaultModel)
      --resume [id|latest]         Resume a previous session (default: latest)
  -p, --prompt <task>              Task/objective for headless modes
      --format <text|ndjson>       Headless run output format (default: text)
      --max-rounds <n>             Mobai/science loop round cap, counted per run (mobai mode: unset = unlimited)
      --max-minutes <n>            Mobai/science loop wall-clock cap (mobai mode: unset = unlimited)
      --permission <mode>          manual|auto|yolo (default: TUI=manual, headless=auto)
      --discipline <math|metric>   Mobai mode: domain pack for node vocabulary + acceptance discipline
  -h, --help                       Show this help

Exit codes (run mode): 0 = success · 1 = error or hook-block
Exit codes (mobai mode): 0 = complete · 2 = budget exhausted · 3 = blocked/no mobai · 1 = error
Exit codes (science mode): 0 = submitted · 2 = budget exhausted · 1 = error
`;

async function resolveResume(cwd: string, resumeArg: string): Promise<JsonlSessionMetadata | undefined> {
	const { env } = await createExecutionEnv(cwd);
	const sessions = await new SessionManager(env, cwd).list();
	return resumeArg === "latest" ? sessions[0] : sessions.find((s) => s.id === resumeArg || s.path === resumeArg);
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(HELP);
		return;
	}
	validateModeFlags(options);

	const cwd = process.cwd();

	if (options.mode === "doctor") {
		// doctor spawns subprocesses, so it must pass the trust gate first
		if (!(await isFolderTrusted(cwd)) && !(await ensureTrustHeadless(cwd))) process.exit(1);
		const checks = await runDoctor(cwd);
		for (const c of checks) {
			console.log(`${c.ok ? SUCCESS_MARK : FAILURE_MARK} ${c.name}: ${c.detail}${c.hint ? `\n    → ${c.hint}` : ""}`);
		}
		process.exit(checks.every((c) => c.ok) ? 0 : 1);
	}

	let resume: JsonlSessionMetadata | undefined;
	if (options.resume) {
		resume = await resolveResume(cwd, options.resume);
		if (!resume) {
			console.error("No session found to resume.");
			process.exit(1);
		}
		// single-writer discipline: refuse to resume a session another live Kea process holds
		const lock = acquireSessionLock(resume.path);
		if (!lock.acquired) {
			console.error(lock.reason);
			process.exit(1);
		}
	}

	const agentCfg = await loadConfig(projectConfigPath(cwd));
	const modelSpec = options.model ?? (typeof agentCfg.defaultModel === "string" ? agentCfg.defaultModel : undefined);

	if (options.mode !== "tui" && !(await isFolderTrusted(cwd))) {
		if (!(await ensureTrustHeadless(cwd))) {
			releaseSessionLocksBestEffort();
			process.exit(1);
		}
	}

	if (options.mode !== "tui" && options.permission === "manual") {
		console.error("--permission manual is not supported in headless mode (no approval handler); use auto or yolo.");
		releaseSessionLocksBestEffort();
		process.exit(1);
	}

	// kernel and research tools share ONE model collection (duplicate custom-provider registration
	// breaks resolution). registerCustomModels deliberately runs before the trust gate: it only reads
	// config and registers in-memory — the gate governs execution, not config reads.
	const models = createModelsCollection(new FileCredentialStore());
	await registerCustomModels(cwd, models);
	const model = resolveModel(models, modelSpec);

	const buildResearchTools = async (
		modelsArg: Models,
		modelArg: Model<Api>,
		opts?: { mobaiDir?: (kernel: Kernel) => string },
	): Promise<{
		tools: AgentTool[];
		dispose(): void;
		bindKernel(kernel: Kernel): void;
		setProgramRound(round: number): void;
	}> => {
		const { env } = await createExecutionEnv(cwd);
		const journal = new Journal(cwd);
		const memory = new MemoryStore(cwd);
		// deferred holders: tools are built before the kernel exists, so kernel-dependent state binds in
		// bindKernel — gates default fail-closed (ask → do not run), getModel follows /model switches,
		// mobaiDir resolves per-session
		let mobaiGate: ((command: string) => "approve" | "deny" | "ask") | undefined;
		let getCurrentModel = (): Model<Api> => modelArg;
		let subagentsRef: SubagentRunner | undefined;
		let kernelRef: Kernel | undefined;
		let mobaiDirRef: (() => string) | undefined;
		let programRound = 1;
		const tools: AgentTool[] = [
			...createResearchTools({
				cwd,
				env,
				models: modelsArg,
				getModel: () => getCurrentModel(),
				journal,
				memory,
				// Data-source wiring for the novelty gate: throwing = sourceFailed = unverified (fail-closed, never novel)
				fetchMaterialRecords: async (query: string) => {
					const result = await queryMaterial({ formula: query });
					if (result.sourceFailed) throw new Error(result.error ?? "material data source unreachable");
					return result.records;
				},
				reviewMobaiCommand: (command: string) => mobaiGate?.(command) ?? "ask",
				reviewEvalCommand: (command: string) => mobaiGate?.(command) ?? "ask",
				subagents: () => subagentsRef,
				mobaiDir: () => mobaiDirRef?.() ?? join(cwd, ".kea"),
				submitSciencePlan: async (plan: string) => {
					const dir = join(plansDir(), "science");
					mkdirSync(dir, { recursive: true });
					const path = join(dir, `${planSlug(randomUUID())}.md`);
					await Bun.write(path, plan);
					kernelRef?.setScienceMode(false);
					return path;
				},
			}),
			asTool(createSearchLiteratureTool()),
			asTool(createQueryMaterialTool()),
			asTool(createValidateReactionsTool()),
			...createProgramTools({
				cwd,
				env,
				mobaiDir: () => mobaiDirRef?.() ?? join(cwd, ".kea"),
				reviewCommand: (command) => mobaiGate?.(command) ?? "ask",
				currentRound: () => programRound,
				subagents: () => subagentsRef,
			}),
		];
		return {
			tools,
			dispose: () => {
				journal.close();
				memory.close();
			},
			bindKernel: (boundKernel: Kernel) => {
				mobaiGate = (command: string) => boundKernel.reviewMobaiCommand(command);
				getCurrentModel = () => boundKernel.model;
				subagentsRef = boundKernel.subagents;
				kernelRef = boundKernel;
				const mobaiDirFn = opts?.mobaiDir;
				if (mobaiDirFn) mobaiDirRef = () => mobaiDirFn(boundKernel);
			},
			setProgramRound: (round: number) => {
				programRound = round;
			},
		};
	};

	if (options.mode === "run") {
		if (!options.prompt) {
			console.error('kea run requires -p "<task>"');
			process.exit(1);
		}
		const research = await buildResearchTools(models, model);
		const kernel = await createKernel({
			cwd,
			model: modelSpec,
			models,
			resume,
			permissionMode: options.permission ?? "auto",
			extraTools: research.tools,
			trusted: true,
			headless: true,
		});
		research.bindKernel(kernel);
		let code = 1;
		try {
			code = await runHeadless(kernel, { prompt: options.prompt, format: options.format });
		} finally {
			// error paths must still settle kernel resources; dispose/close are best-effort and must never
			// hang exit or override the exit code
			await kernel.dispose().catch(() => {});
			await closeWithWatchdog(() => kernel.close(), 2000);
			research.dispose();
			releaseSessionLocksBestEffort();
		}
		process.exit(code);
	}

	if (options.mode === "mobai") {
		const research = await buildResearchTools(models, model);
		const kernel = await createKernel({
			cwd,
			model: modelSpec,
			models,
			resume,
			permissionMode: options.permission ?? "auto",
			extraTools: research.tools,
			trusted: true,
			headless: true,
		});
		research.bindKernel(kernel);
		const hasProgram = await Bun.file(programPathIn(join(cwd, ".kea"))).exists();
		if (!options.prompt && hasProgram) {
			// a ledger settled exhausted by an older build is a closed book (the tools refuse its mutations)
			// — re-formalize with a new objective, do not loop over it
			const existing = await loadProgram(join(cwd, ".kea"));
			if (existing?.status === "exhausted") {
				console.error("program is exhausted — re-formalize with a new objective or /mobai replace");
				releaseSessionLocksBestEffort();
				process.exit(3);
			}
		}
		if (options.prompt && hasProgram) {
			// a fresh objective over an unfinished program would fork the ledger mid-flight
			const existing = await loadProgram(join(cwd, ".kea"));
			if (existing?.status === "active" || existing?.status === "blocked") {
				console.error(
					`program at ${programPathIn(join(cwd, ".kea"))} is ${existing.status} — continue it with \`kea mobai\` (no -p) or clear the active program first`,
				);
				releaseSessionLocksBestEffort();
				process.exit(3);
			}
		}
		if (options.prompt || hasProgram) {
			let report: ProgramReport;
			try {
				report = await runProgramLoop(kernel, {
					cwd,
					objective: options.prompt,
					// unlimited by default: without a machine-verified completion the loop keeps advancing
					maxRounds: options.maxRounds,
					wallClockMs: options.maxMinutes !== undefined ? options.maxMinutes * 60_000 : undefined,
					setProgramRound: research.setProgramRound,
					discipline: options.discipline,
					// process.stdout.write, not console.log: console.log is block-buffered when redirected,
					// which left run.log files empty for hours
					log: (line) => process.stdout.write(`${line}\n`),
				});
			} finally {
				await kernel.dispose().catch(() => {});
				await closeWithWatchdog(() => kernel.close(), 2000);
				research.dispose();
				releaseSessionLocksBestEffort();
			}
			console.log(JSON.stringify(report, null, 2));
			const code =
				report.outcome === "complete"
					? 0
					: report.outcome === "budget_exhausted"
						? 2
						: report.outcome === "error"
							? 1
							: 3;
			process.exit(code);
		}
		let report: MobaiReport;
		try {
			report = await runMobaiLoop(kernel, {
				cwd,
				objective: options.prompt,
				// unlimited by default (program-loop semantics): unset caps pass through as undefined
				maxRounds: options.maxRounds,
				wallClockMs: options.maxMinutes !== undefined ? options.maxMinutes * 60_000 : undefined,
				log: (line) => process.stdout.write(`${line}\n`),
			});
		} finally {
			await kernel.dispose().catch(() => {});
			await closeWithWatchdog(() => kernel.close(), 2000);
			research.dispose();
			releaseSessionLocksBestEffort();
		}
		console.log(JSON.stringify(report, null, 2));
		const code =
			report.outcome === "complete"
				? 0
				: report.outcome === "budget_exhausted"
					? 2
					: report.outcome === "error"
						? 1
						: 3;
		process.exit(code);
	}

	if (options.mode === "science") {
		const research = await buildResearchTools(models, model);
		const kernel = await createKernel({
			cwd,
			model: modelSpec,
			models,
			resume,
			permissionMode: options.permission ?? "auto",
			extraTools: research.tools,
			trusted: true,
			headless: true,
		});
		research.bindKernel(kernel);
		let report: ScienceReport;
		try {
			report = await runScienceLoop(kernel, {
				problem: options.prompt,
				cwd,
				maxRounds: options.maxRounds ?? 12,
				wallClockMs: (options.maxMinutes ?? 60) * 60_000,
			});
		} finally {
			await kernel.dispose().catch(() => {});
			await closeWithWatchdog(() => kernel.close(), 2000);
			research.dispose();
			releaseSessionLocksBestEffort();
		}
		console.log(JSON.stringify(report, null, 2));
		const code = report.outcome === "submitted" ? 0 : report.outcome === "budget_exhausted" ? 2 : 1;
		process.exit(code);
	}

	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error('kea requires an interactive terminal. Use `kea run -p "<task>"` headless.');
		releaseSessionLocksBestEffort();
		process.exit(1);
	}

	if (!(await runTrustPromptTui(cwd))) {
		releaseSessionLocksBestEffort();
		process.exit(1);
	}

	const research = await buildResearchTools(models, model, {
		mobaiDir: (sessionKernel) => sessionMobaiDir(cwd, sessionKernel.sessionId),
	});
	const kernel = await createKernel({
		cwd,
		model: modelSpec,
		models,
		resume,
		permissionMode: options.permission ?? "manual",
		extraTools: research.tools,
		trusted: true,
	});
	research.bindKernel(kernel);
	if (!options.resume) {
		// single-writer discipline covers freshly created sessions too — the TUI writes them from here on
		const created = await kernel.session.getMetadata();
		const lock = acquireSessionLock(created.path);
		if (!lock.acquired) {
			console.error(lock.reason);
			process.exit(1);
		}
	}
	if (kernel.wasInterrupted) {
		console.error("note: previous run in this session was interrupted; transcript restored.");
	}
	// runTui returns a promise that never resolves; exit is app.exit() → shutdown (including onExit hook) → process.exit
	await runTui(kernel, {
		onExit: () => research.dispose(),
		// the TUI auto-continue drives program rounds — its counter is the single source of the journal round stamp
		onProgramRound: research.setProgramRound,
	});
}

async function runTrustPromptTui(cwd: string): Promise<boolean> {
	const info = await getWorkspaceTrustInfo(cwd);
	if (info.trusted) return true;
	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal, true);
	let resolveChoice!: (choice: TrustChoice) => void;
	const choice = new Promise<TrustChoice>((resolve) => {
		resolveChoice = resolve;
	});
	const prompt = new TrustPrompt(
		{ workDir: cwd, gatedMcpServers: info.gatedMcpServers, onSelect: (c) => resolveChoice(c) },
		createTheme(),
	);
	tui.addChild(prompt);
	tui.setFocus(prompt);
	tui.start();
	const picked = await choice;
	tui.stop();
	if (picked !== "trust") return false; // keep the prompt as the last frame — do not restore the editor
	await trustFolder(cwd);
	return true;
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	releaseSessionLocksBestEffort();
	process.exit(1);
});
