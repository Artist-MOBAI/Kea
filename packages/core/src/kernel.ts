import type {
	AgentMessage,
	AgentTool,
	CompactionSettings,
	JsonlSessionMetadata,
	Skill,
} from "@earendil-works/pi-agent-core";
import { Agent, formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, Models } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "./auth-store.ts";
import type { BudgetCheck, BudgetLimits } from "./budget.ts";
import { BudgetGuard } from "./budget.ts";
import { COMPACTION_SETTINGS, isReminderOnlyMessage, runCompaction } from "./compaction.ts";
import { ContextSizeTracker, requestTokensOf } from "./context-size.ts";
import { createExecutionEnv } from "./env.ts";
import { KernelEventBus, type RunOutcome } from "./events.ts";
import { BackendRegistry } from "./execution/backend.ts";
import { loadBackendsConfig } from "./execution/backends-config.ts";
import { HumanBackend } from "./execution/human.ts";
import { LocalBackend } from "./execution/local.ts";
import { ModalBackend } from "./execution/modal.ts";
import { SlurmBackend } from "./execution/slurm.ts";
import { SshBackend } from "./execution/ssh.ts";
import { createJobTools } from "./execution/tools.ts";
import { createJobWatcher, type JobWatcherEvent } from "./execution/watcher.ts";
import { HookBlockedError, HookRunner, loadHooksConfig, truncateToolInput } from "./hooks.ts";
import { InjectionScheduler } from "./injection/scheduler.ts";
import { stagnationMessage } from "./loop/stagnation.ts";
import { TurnController } from "./loop/turn-controller.ts";
import { loadMcpConfig, McpBridge, type McpBridgeStatus } from "./mcp.ts";
import { MemoryStore } from "./memory.ts";
import { createModelsCollection, registerCustomModels, resolveModel } from "./models.ts";
import {
	type ApprovalHandler,
	classifyTool,
	type ExecPolicy,
	execpolicyWarning,
	loadExecPolicy,
	type PermissionMode,
	PolicyEngine,
	pathOf,
	type ToolRequest,
} from "./permission.ts";
import {
	createEnterPlanModeTool,
	createExitPlanModeTool,
	createPlanReminderProvider,
	PlanService,
	type PlanState,
} from "./plan.ts";
import {
	isContextOverflowError,
	MAX_OVERFLOW_COMPACTION_ATTEMPTS,
	makeErrorAssistantMessage,
	OVERFLOW_CONTEXT_SAFETY_RATIO,
	OVERFLOW_CONTINUE_TEXT,
	streamWithRetry,
} from "./retry.ts";
import { type KeaSession, SessionManager } from "./session.ts";
import { foldProjection } from "./session-projection.ts";
import { repairToolCallPairing } from "./session-repair.ts";
import { loadAllSkills } from "./skills.ts";
import { SubagentRunner } from "./subagent/runner.ts";
import { createSpawnAgentTool, createSwarmTool } from "./subagent/tools.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { wrapSystemReminder } from "./text.ts";
import {
	createTodoListTool,
	createTodoReminderProvider,
	type TodoItem,
	type TodoStore,
	todoEntryProjection,
} from "./todo.ts";
import { asTool, createBaseTools } from "./tools.ts";
import { createReadMediaFileTool } from "./tools-media.ts";
import { createFetchUrlTool, createLocalFetcher, createWebSearchTool, searchProviderFromEnv } from "./web/index.ts";

export interface KernelOptions {
	cwd: string;
	model?: string;
	resume?: JsonlSessionMetadata;
	models?: Models;
	compactionSettings?: CompactionSettings;
	budget?: BudgetLimits;
	permissionMode?: PermissionMode;

	headless?: boolean;
	approvalHandler?: ApprovalHandler;

	extraTools?: AgentTool[];
	/** gates project-level MCP loading */
	trusted?: boolean;
}

export interface Kernel {
	readonly agent: Agent;
	readonly model: Model<Api>;
	readonly models: Models;
	readonly tools: readonly AgentTool[];
	readonly session: KeaSession;
	readonly sessionId: string;
	readonly sessions: SessionManager;
	readonly events: KernelEventBus;
	readonly trusted: boolean;
	readonly wasInterrupted: boolean;
	readonly permissionMode: PermissionMode;
	/** orthogonal plan mode (not mutually exclusive with permission) */
	readonly planMode: boolean;
	/** science mode (mutually exclusive with planMode; read-only orchestration) */
	readonly scienceMode: boolean;
	readonly subagents: SubagentRunner;
	readonly jobs: LocalBackend;
	readonly backends: BackendRegistry;
	readonly humanJobs: HumanBackend;
	readonly memory: MemoryStore;
	mcpStatuses(): McpBridgeStatus[];
	watchJobs(onSettled: (event: JobWatcherEvent) => void): { stop(): void };

	approvalHandler: ApprovalHandler | undefined;

	budgetState(): BudgetCheck | undefined;
	/** reminder-class injections: providers register here; collected at turn end, replayable after compaction */
	readonly injections: InjectionScheduler;
	/** current session's todo list (read-only snapshot; writes go through the todo_list tool) */
	readonly todos: readonly TodoItem[];
	/** plan-mode state (when active, path is the current plan file) */
	readonly plan: PlanState;
	/** cumulative tokens/cost since kernel start (compaction-immune, unlike values derived from surviving context messages). */
	usage(): { tokens: number; usd: number };
	/** current context size under the usage-anchored metric (baseline + pending delta, envelope included while unanchored). */
	contextTokens(): number;
	/** effective context window: the model's declared window, possibly lowered by observed-overflow calibration. */
	readonly contextWindow: number;
	setPermissionMode(mode: PermissionMode): void;
	setPlanMode(on: boolean): void;
	setScienceMode(on: boolean): void;
	setModel(spec: string): Model<Api>;
	setThinking(level: "off" | "minimal" | "low" | "medium" | "high"): void;

	reloadCustomModels(): Promise<string[]>;
	compactNow(instruction?: string): Promise<{ applied: boolean; reason?: string }>;
	/** busy gate: idle-only commands are blocked during compaction too (race with transcript rewriting). */
	isCompacting(): boolean;
	reloadPolicy(): Promise<void>;
	/** execpolicy advisory warning text for the approval panel's danger badge (never blocks). */
	reviewExec(command?: string): string | undefined;
	/** check_goal command-criterion permission gate: a non-approve criterion must not run approval-free via a mobai check */
	reviewMobaiCommand(command: string): "approve" | "deny" | "ask";
	/** "allow for this session": memorize authorization by request identity (command form/normalized path/tool name), cleared on session switch */
	rememberApproval(req: ToolRequest): void;
	newSession(): Promise<string>;

	switchSession(metadata: JsonlSessionMetadata): Promise<void>;
	prompt(text: string): Promise<void>;
	/** inject an additional instruction mid-stream (doesn't interrupt the current turn) */
	steer(text: string): void;
	/** append a reminder-channel message at a safe idle position: persisted, model-visible on the next request,
	 * wrapped in the system-reminder tag; no-op while a run is in flight. */
	appendSystemReminder(text: string): Promise<void>;
	abort(): void;
	close(): Promise<void>;
	/** exit cleanup: fire SessionEnd(reason exit) (awaiting hook completion) and close resources; idempotent, no more session hooks after dispose */
	dispose(): Promise<void>;
}

function isLlmMessage(m: AgentMessage): m is Message {
	return typeof m === "object" && m !== null && "role" in m;
}

export async function createKernel(options: KernelOptions): Promise<Kernel> {
	const { cwd } = options;
	const trusted = options.trusted ?? false;

	const credentialStore = new FileCredentialStore();
	const models = options.models ?? createModelsCollection(credentialStore);
	// project-level custom providers load only in a trusted directory (same gate as MCP): a malicious repo
	// could redirect traffic through an attacker baseUrl and exfiltrate keys
	if (trusted) await registerCustomModels(cwd, models);
	let model = resolveModel(models, options.model);
	const { env } = await createExecutionEnv(cwd);
	const sessions = new SessionManager(env, cwd);
	const memory = new MemoryStore(cwd);
	const compactionSettings = options.compactionSettings ?? COMPACTION_SETTINGS;
	const budgetGuard = options.budget ? new BudgetGuard(options.budget) : undefined;
	const contextTracker = new ContextSizeTracker();
	let effectiveContextWindow = model.contextWindow;
	const turnController = new TurnController({
		budget: budgetGuard,
		compactionSettings,
		contextWindow: effectiveContextWindow,
		contextTokens: (messages) => contextTracker.current(messages),
	});
	const events = new KernelEventBus();
	const injection = new InjectionScheduler();

	const { skills } = await loadAllSkills(env, cwd, trusted);
	let execPolicy: ExecPolicy = trusted ? await loadExecPolicy(cwd) : { warn: [] };
	const policyEngine = new PolicyEngine({ mode: options.permissionMode ?? "manual", cwd, trusted });
	// project-level hooks load only in a trusted directory (same gate as MCP): a hook is arbitrary shell execution, more dangerous than MCP
	// sample sessionId/model lazily: after session switch/setModel the envelope always carries the current values
	// TDZ constraint: the sessionId closure references currentSessionId declared later — no hook may fire before construction completes
	const hooks = new HookRunner(trusted ? await loadHooksConfig(cwd) : {}, {
		sessionId: () => currentSessionId,
		cwd,
		model: () => modelSpecOf(model),
	});
	const subagents = new SubagentRunner({
		cwd,
		models,
		trusted,
		getModel: () => model,
		toolGate: gateToolCall,
		hooks,
		extraTools: options.extraTools,
	});

	// JobFinished dedupe gate: the watcher notification and direct settlement paths (job_cancel/submit_experiment_result) may both arrive,
	// so fire once per job. Settle before firing the hook: every call site reaches here only after the ledger is final
	const jobFinishedFired = new Set<string>();
	const fireJobFinished = (jobId: string, backend: string, outcome: string): void => {
		if (jobFinishedFired.has(jobId)) return;
		jobFinishedFired.add(jobId);
		hooks.fireAndForget("JobFinished", { job_id: jobId, backend, outcome });
	};

	const mcpBridge = new McpBridge();
	await mcpBridge.connectAll(await loadMcpConfig(cwd, { includeProject: trusted }));

	const localBackend = new LocalBackend(env, cwd);
	const humanBackend = new HumanBackend(cwd);
	const modalBackend = new ModalBackend(cwd);
	const backends = new BackendRegistry(cwd);
	backends.register(localBackend);
	backends.register(humanBackend);
	backends.register(modalBackend);
	// backends.json is project-level remote execution config (SSH/Slurm target hosts), loaded only in a trusted directory:
	// an untrusted repo could preset a malicious host and make startup-phase reclaimOrphans open a remote SSH.
	if (trusted) {
		for (const entry of await loadBackendsConfig(cwd)) {
			if (entry.type === "ssh") backends.register(new SshBackend(cwd, entry.config, entry.name));
			else backends.register(new SlurmBackend(cwd, entry.config, entry.name));
		}
	}
	// settle orphan jobs left from previous runs (registered backends, remote included when trusted)
	await backends.reclaimAll();

	const todoStore: TodoStore = (() => {
		let items: TodoItem[] = [];
		return {
			get: () => items,
			set: (next) => {
				items = [...next];
			},
		};
	})();

	const planService = new PlanService();
	const planCallbacks = {
		plan: planService,
		isActive: () => policyEngine.currentPlanMode,
		enterPlan: () => {
			policyEngine.setPlanMode(true);
			// plan files are session-scoped: concurrent sessions must not share one
			const state = planService.enter(currentSessionId);
			policyEngine.setPlanFilePath(state.path);
			events.emit({ type: "plan_mode_changed", on: true });
		},
		exitPlan: () => {
			planService.exit();
			policyEngine.setPlanFilePath(undefined);
			policyEngine.setPlanMode(false);
			events.emit({ type: "plan_mode_changed", on: false });
		},
		// in auto mode the plan exit is approved silently by the policy chain — mark it in the tool result so
		// the transcript shows HOW it was approved
		approvalNote: () => (policyEngine.currentMode === "auto" ? "\n(Approval: Auto-approved — auto mode)" : ""),
		readPlanFile: async () => {
			const path = planService.current.path;
			if (!path) return "";
			const file = Bun.file(path);
			return (await file.exists()) ? await file.text() : "";
		},
	};

	const webSearchProvider = searchProviderFromEnv();
	const tools: AgentTool[] = [
		...createBaseTools(env),
		asTool(createReadMediaFileTool({ cwd, supportsImages: () => model.input.includes("image") })),
		asTool(createTodoListTool(todoStore)),
		asTool(createEnterPlanModeTool(planCallbacks)),
		asTool(createExitPlanModeTool(planCallbacks)),
		asTool(createFetchUrlTool(createLocalFetcher())),
		...(webSearchProvider ? [asTool(createWebSearchTool(webSearchProvider))] : []),
		asTool(createSpawnAgentTool(subagents)),
		asTool(createSwarmTool(subagents)),
		...createJobTools({
			// pass the kernel cwd explicitly: headless runs can start from a different process cwd
			cwd,
			registry: backends,
			human: humanBackend,
			submitGuard: budgetGuard ? () => budgetGuard.checkJobs(localBackend.activeCount())?.message : undefined,
			onJobSubmitted: (jobId, backend) => hooks.fireAndForget("JobSubmitted", { job_id: jobId, backend }),
			onJobSettled: fireJobFinished,
		}).map(asTool),
		...(await mcpBridge.wrappedTools()),
		...(options.extraTools ?? []),
	];

	injection.register(createTodoReminderProvider(todoStore));
	injection.register(
		createPlanReminderProvider(
			() => policyEngine.currentPlanMode,
			() => planService.current.path,
		),
	);

	let session = options.resume ? await sessions.open(options.resume) : await sessions.create(modelSpecOf(model));
	// model-visible system prompt is a durable fact: record it at creation, reconstruct it on resume
	// (fresh derivation only for legacy sessions that predate the record).
	let systemPromptText: string;
	if (options.resume) {
		systemPromptText =
			(await sessions.readSystemPrompt(session)) ??
			(await buildSystemPromptText(cwd, memory.injectionText(), skills, options.headless));
	} else {
		systemPromptText = await buildSystemPromptText(cwd, memory.injectionText(), skills, options.headless);
		await sessions.recordSystemPrompt(session, systemPromptText);
	}
	let currentSessionId = (await session.getMetadata()).id;
	/** after dispose() no more session lifecycle hooks (SessionEnd exit fires exactly once) */
	let disposed = false;
	hooks.fireAndForget(
		"SessionStart",
		{ source: options.resume ? "resume" : "startup" },
		options.resume ? "resume" : "startup",
	);
	let wasInterrupted = false;
	let approvalHandler: ApprovalHandler | undefined = options.approvalHandler;

	// ids of tool calls blocked by the gate (never actually executed): pi still fires tool_execution_end for
	// blocked calls, but PostToolUse follows real executions only, so the end translator skips the hook for
	// these ids. The main-agent path deletes on tool_execution_end; subagent blocked ids have no kernel-side
	// end event and stay in the set (negligible size).
	const blockedToolCalls = new Set<string>();

	// unified tool-call gate (main loop + subagents): hooks → policy → approval. Function hoisting:
	// SubagentRunner references it during construction above; the call happens later.
	async function gateToolCall(ctx: {
		toolCall: { id: string; name: string };
		args: unknown;
	}): Promise<{ block: boolean; reason: string } | undefined> {
		const toolName = ctx.toolCall.name;
		const hookOutcome = await hooks.fireBlocking("PreToolUse", { tool_name: toolName, tool_input: ctx.args }, toolName);
		// on blocked:true, hooks.ts guarantees a non-empty reason (stderr.trim() || fallback text)
		if (hookOutcome.blocked) {
			blockedToolCalls.add(ctx.toolCall.id);
			return { block: true, reason: `Blocked by hook: ${hookOutcome.reason}` };
		}
		const kind = classifyTool(toolName);
		const command = kind === "exec" ? ((ctx.args as { command?: unknown }).command as string | undefined) : undefined;
		const request: ToolRequest = { toolName, args: ctx.args, kind, command, path: pathOf(ctx.args) };

		const decision = policyEngine.evaluate(request);
		if (decision.verdict === "approve") return undefined;
		if (decision.verdict === "deny") {
			blockedToolCalls.add(ctx.toolCall.id);
			return {
				block: true,
				reason: `Blocked (${decision.ruleId}): ${decision.reason ?? "denied by policy"}. Do not retry unchanged.`,
			};
		}

		const handler = approvalHandler;
		if (!handler) {
			blockedToolCalls.add(ctx.toolCall.id);
			return {
				block: true,
				reason: `Approval required (${decision.ruleId}${decision.reason ? `: ${decision.reason}` : ""}) but no approval handler is attached.`,
			};
		}
		const answer = await handler(request);
		if (answer === "approve") return undefined;
		blockedToolCalls.add(ctx.toolCall.id);
		if (typeof answer === "object") {
			return {
				block: true,
				reason: `Denied by user (${decision.ruleId}). User feedback: ${answer.feedback} Change approach, do not route around the denial.`,
			};
		}
		return {
			block: true,
			reason: `Denied by user (${decision.ruleId}). Change approach, do not route around the denial.`,
		};
	}

	// envelope counted only while the tracker is unanchored — a usage anchor already includes it
	contextTracker.setEnvelope(systemPromptText, tools);

	const agent = new Agent({
		initialState: {
			systemPrompt: systemPromptText,
			model,
			tools,
			thinkingLevel: "medium",
		},
		sessionId: currentSessionId,
		streamFn: (m, context, opts) =>
			streamWithRetry(() => models.streamSimple(m, context, opts), {
				signal: opts?.signal,
				onRetry: (info) => events.emit({ type: "model_retry", ...info }),
				makeErrorMessage: (errorMessage) => makeErrorAssistantMessage(m, errorMessage),
			}),
		convertToLlm: (messages) => repairToolCallPairing(messages.filter(isLlmMessage)),

		beforeToolCall: async (ctx) => gateToolCall(ctx),

		// MCP passthrough tools put the protocol isError on the result object; pi marks every non-throwing
		// result isError:false, so the error mark gets swallowed — lift the result's own isError up (only when
		// pi didn't record an error, never overriding an existing error flag)
		afterToolCall: async (ctx) => {
			if (!ctx.isError && (ctx.result as { isError?: boolean }).isError === true) return { isError: true };
			return undefined;
		},

		shouldStopAfterTurn: (ctx) => {
			const decision = turnController.evaluateTurnEnd(ctx.context.messages);
			if (decision.steerText) {
				agent.steer({ role: "user", content: [{ type: "text", text: decision.steerText }], timestamp: Date.now() });
			}
			return decision.stop;
		},
	});

	if (options.resume) {
		agent.state.messages = await sessions.replay(session);
		wasInterrupted = (await sessions.interruptedRuns(session)).length > 0;
		// recover todo from the raw entry stream: folding the pruned replayed messages would drop
		// todo_list writes that a compaction summarized away
		const restoredTodos = foldProjection(todoEntryProjection, await sessions.entries(session));
		todoStore.set(restoredTodos ?? []);
	}

	let activeRunId: string | undefined;
	// current run is held by the prompt() chain (agent.prompt + tail compaction/continue): during agent_end
	// only record the result, don't settle
	let runOwnedByPrompt = false;
	// per-run single-settlement gate: prompt()'s try/finally races the non-holding agent_end path, first one wins
	let runFinalized = false;
	// latest result recorded at each agent_end while held (successive runs in the chain overwrite, last wins)
	let lastRunOutcome: RunOutcome = "completed";
	let lastRunError: string | undefined;
	// Stop-hook loop guard (kimi parity: one hook-requested continuation per chain). The steer is drained
	// by the NEXT run's loop start, so `pending` carries the armed state across; a prompt without it resets.
	let stopHookContinuationUsed = false;
	let stopHookContinuationPending = false;
	// the user message prompt() already appended (by reference) — excluded at message_end ledger write;
	// only steer-injected ones are added
	let lastPromptedUser: Message | undefined;
	// one abort controller per prompt(): the agent's own signal only covers the agent run lifecycle; the tail
	// compaction summary call happens after settlement (agent idle) and needs its own controller
	let runAbort: AbortController | undefined;
	const pendingToolArgs = new Map<string, string>();
	const pendingToolStart = new Map<string, number>();

	const computeRunOutcome = (): { outcome: RunOutcome; error?: string } => {
		const last = [...agent.state.messages].reverse().find((m) => "role" in m && m.role === "assistant");
		const aborted = "stopReason" in (last ?? {}) && (last as { stopReason?: string }).stopReason === "aborted";
		const errorMessage = agent.state.errorMessage;
		if (aborted) return { outcome: "aborted" };
		if (errorMessage !== undefined) return { outcome: "failed", error: errorMessage };
		return { outcome: "completed" };
	};

	// settle the current run (ledger finishRun + run_end + Stop hook) exactly once (runFinalized gate), with the
	// session captured at run creation: the tail chain may cross a session switch and must not write into the
	// new session's ledger.
	const finalizeRun = async (runSession: KeaSession, outcome: RunOutcome, error?: string): Promise<void> => {
		if (activeRunId === undefined || runFinalized) return;
		runFinalized = true;
		const runId = activeRunId;
		activeRunId = undefined;
		runOwnedByPrompt = false;
		// abort this run's still-running compaction summary call (no-op on the normal path)
		runAbort?.abort();
		runAbort = undefined;
		try {
			await sessions.finishRun(runSession, runId, outcome, error);
		} catch (err) {
			// a ledger write failure must not deadlock settlement: run_end/Stop must still fire, or the TUI hangs.
			// An unclosed run stays in the ledger, covered by the interruptedRuns repair hint on resume.
			console.error("[kea] ledger finishRun failed:", err);
		}
		events.emit({ type: "run_end", runId, outcome, error });
		// a Stop hook may veto a NORMAL completion and request one more round; abort/error settlements keep the
		// fire-and-forget notification — a hook cannot resurrect a failed run. At most ONE hook-requested
		// continuation per chain: an always-blocking Stop hook must not steer forever.
		if (outcome === "completed") {
			const stop = await hooks.fireStop(outcome, stopHookContinuationUsed);
			if (stop.blocked) {
				if (stopHookContinuationUsed) {
					console.warn("[kea] Stop hook blocked again after its requested continuation; not steering again");
				} else {
					stopHookContinuationUsed = true;
					stopHookContinuationPending = true;
					agent.steer({
						role: "user",
						content: [
							{
								type: "text",
								text: wrapSystemReminder(`${stop.reason ?? "A Stop hook requested continuation."} Continue the task.`),
							},
						],
						timestamp: Date.now(),
					});
				}
			}
		} else {
			hooks.fireAndForget("Stop", { outcome, stop_hook_active: stopHookContinuationUsed });
		}
		// sweep unpaired tool_start residue (abort/exception-path safety)
		pendingToolArgs.clear();
		pendingToolStart.clear();
	};

	// no-op while a run is in flight: a mid-run append would interleave with the run's own ledger writes
	const appendReminderMessage = async (text: string): Promise<void> => {
		if (activeRunId !== undefined) return;
		const message: Message = {
			role: "user",
			content: [{ type: "text", text: wrapSystemReminder(text) }],
			timestamp: Date.now(),
		};
		await sessions.append(session, [message]);
		agent.state.messages = [...agent.state.messages, message];
	};

	agent.subscribe(async (event) => {
		switch (event.type) {
			case "turn_end": {
				try {
					await sessions.append(session, [event.message, ...event.toolResults]);
				} catch (err) {
					// a ledger write failure must not break event settlement (finalizeRun models this); replay repair covers the gap
					console.error("[kea] ledger append failed:", err);
				}
				// reminder-class injections collect at the end of normally-finished turns (not on abort/error);
				// pi drains steer-queued messages in the same run's next turn — each reminder costs one LLM turn.
				const stopReason = (event.message as { stopReason?: string }).stopReason;
				if (stopReason !== "aborted" && stopReason !== "error") {
					for (const text of injection.collect({ isNewTurn: false, messages: agent.state.messages })) {
						agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
					}
				}
				break;
			}
			case "tool_execution_start": {
				const argsKey = JSON.stringify(event.args);
				pendingToolArgs.set(event.toolCallId, argsKey);
				pendingToolStart.set(event.toolCallId, Date.now());
				events.emit({ type: "tool_start", toolCallId: event.toolCallId, name: event.toolName, args: event.args });
				break;
			}
			case "tool_execution_update":
				events.emit({
					type: "tool_update",
					toolCallId: event.toolCallId,
					name: event.toolName,
					partial: event.partialResult,
				});
				break;
			case "tool_execution_end": {
				const argsKey = pendingToolArgs.get(event.toolCallId) ?? "";
				// pi contract: for the same callId, tool_execution_start always precedes end; both maps clear only at agent_end (after all ends)
				const startedAt = pendingToolStart.get(event.toolCallId) as number;
				pendingToolArgs.delete(event.toolCallId);
				pendingToolStart.delete(event.toolCallId);
				const stagnation = turnController.recordToolCall(event.toolName, argsKey, event.isError);
				if (stagnation) {
					agent.steer({
						role: "user",
						content: [{ type: "text", text: stagnationMessage(stagnation) }],
						timestamp: Date.now(),
					});
				}
				events.emit({
					type: "tool_end",
					toolCallId: event.toolCallId,
					name: event.toolName,
					isError: event.isError,
					durationMs: Date.now() - startedAt,
					resultPreview: resultPreviewOf(event.result),
					details: resultDetailsOf(event.result),
				});
				// a gate-blocked call never actually executed: skip only the PostToolUse hook (real executions
				// only); the delete also clears the blocked-call ledger entry
				if (!blockedToolCalls.delete(event.toolCallId)) {
					// tool_execution_end carries no args: reuse the JSON key captured at start, truncated to the shared cap
					hooks.fireAndForget(
						"PostToolUse",
						{
							tool_name: event.toolName,
							tool_input: truncateToolInput(argsKey),
							tool_call_id: event.toolCallId,
							is_error: event.isError,
						},
						event.toolName,
					);
				}
				break;
			}
			case "message_start":
				events.emit({ type: "message_start", message: event.message });
				break;
			case "message_update":
				events.emit({
					type: "message_delta",
					message: event.message,
					text: textOf(event.message),
					thinking: thinkingOf(event.message),
				});
				break;
			case "message_end": {
				const msg = event.message;
				// every settled assistant message with real usage re-baselines the tracker on the exact request
				// size the provider just reported
				if (isLlmMessage(msg) && msg.role === "assistant") {
					const requestTokens = requestTokensOf((msg as { usage?: Parameters<typeof requestTokensOf>[0] }).usage);
					if (requestTokens > 0) contextTracker.anchorUsage(requestTokens, msg);
				}
				// steer-injected user messages also go into the ledger; prompt()'s own message is excluded by reference
				if (isLlmMessage(msg) && msg.role === "user" && msg !== lastPromptedUser) {
					try {
						await sessions.append(session, [msg]);
					} catch (err) {
						// same settlement discipline as turn_end: a ledger write failure must not break the event chain
						console.error("[kea] ledger append failed:", err);
					}
				}
				events.emit({
					type: "message_end",
					message: event.message,
					text: textOf(event.message),
					thinking: thinkingOf(event.message),
				});
				break;
			}
			case "agent_end": {
				if (activeRunId === undefined) break;
				if (runOwnedByPrompt) {
					// the prompt() chain holds this run: record only; settlement is unified in prompt()'s try/finally
					const info = computeRunOutcome();
					lastRunOutcome = info.outcome;
					lastRunError = info.error;
					// sweep unpaired tool_start residue; safe across runs in the chain (new callIds re-register)
					pendingToolArgs.clear();
					pendingToolStart.clear();
					break;
				}
				// a non-prompt()-driven agent_end: keep the old semantics, settle in place with the current session
				const info = computeRunOutcome();
				await finalizeRun(session, info.outcome, info.error);
				break;
			}
			default:
				break;
		}
	});

	let compacting = 0;
	const runCompactionWithEvents = async (
		targetSession: KeaSession = session,
		signal?: AbortSignal,
		trigger: "manual" | "auto" = "auto",
		instruction?: string,
	): Promise<{ ok: boolean; error?: string }> => {
		// any throw after PreCompact (token estimation/event dispatch) must pair with PostCompact: wrap everything in try
		compacting += 1;
		try {
			hooks.fireAndForget("PreCompact", { trigger }, trigger);
			const tokensBefore = contextTracker.current(agent.state.messages);
			events.emit({ type: "compaction_started" });
			const entries = await sessions.entries(targetSession);
			const result = await runCompaction({
				session: targetSession,
				entries,
				models,
				model,
				settings: compactionSettings,
				signal,
				instruction,
			});
			if (!result.ok) {
				// even on failure the terminal event must fire, otherwise the TUI's compaction view and render timer hang forever
				events.emit({ type: "compaction_failed", reason: result.error });
				hooks.fireAndForget("PostCompact", { trigger, applied: false, error: result.error }, trigger);
				return { ok: false, error: result.error };
			}
			// replay only if the target session is still the current one: the prompt tail chain may have crossed a session switch, never overwrite the new session with a stale transcript
			if (targetSession === session) {
				agent.state.messages = await sessions.replay(targetSession);
				// compaction rewrites the transcript by cloning retained-tail messages: re-mark them counted to
				// avoid the next turn doubling accumulated usage by object identity
				turnController.rebaseAfterCompaction(agent.state.messages);
				// the usage anchor referred to a pre-compaction request: drop it; the tracker falls back to
				// envelope + content until the next real request
				contextTracker.invalidate();
				const tokensAfter = contextTracker.current(agent.state.messages);
				injection.noteCompacted();
				// undelivered reminders queued by the run's last turn_end duplicate the fresh re-announce set
				// below (both would drain into the next request): drop the stale reminder-only entries first;
				// user-typed input queued mid-run must survive (agent.clearSteeringQueue would drop it too)
				dropQueuedReminders(agent);
				// the FIRST post-compaction request must already carry reminder state: collect the re-announce
				// set now and steer-queue it (drained by the next continue()/prompt) instead of waiting for the
				// next turn_end — one full turn late
				for (const reminder of injection.collect({ isNewTurn: true, messages: agent.state.messages })) {
					agent.steer({ role: "user", content: [{ type: "text", text: reminder }], timestamp: Date.now() });
				}
				events.emit({ type: "compaction_applied", tokensBefore, tokensAfter });
				hooks.fireAndForget(
					"PostCompact",
					{ trigger, applied: true, tokens_before: tokensBefore, tokens_after: tokensAfter },
					trigger,
				);
			} else {
				// compacted a non-current session: the current transcript is unchanged, tokensAfter doesn't apply to the current session, surface only tokensBefore
				events.emit({ type: "compaction_applied", tokensBefore });
				hooks.fireAndForget("PostCompact", { trigger, applied: true, tokens_before: tokensBefore }, trigger);
			}
			return { ok: true };
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			events.emit({ type: "compaction_failed", reason });
			hooks.fireAndForget("PostCompact", { trigger, applied: false, error: reason }, trigger);
			return { ok: false, error: reason };
		} finally {
			compacting -= 1;
		}
	};

	// pre-switch step: interrupt any running run and wait for settlement. A held run settles via prompt()'s
	// try/finally into the old-session ledger captured at run creation, so even a late settlement won't pollute
	// the new session. pi reset() throws when a run is in flight and already clears the transcript.
	const settleActiveRun = async (): Promise<void> => {
		agent.abort();
		// during the tail compaction chain the agent is already idle: also abort the run controller to break
		// the in-flight summary LLM call
		runAbort?.abort();
		await agent.waitForIdle();
	};

	// common steps to switch into a new session (emits no events: callers finish their own todo/state changes)
	const applySessionSwitch = (next: KeaSession, nextId: string): void => {
		agent.reset();
		session = next;
		currentSessionId = nextId;
		// pi passes agent.sessionId to the provider for cache routing on every request: sync it, or later
		// requests hang under the old id
		agent.sessionId = nextId;
		// "allow for this session" grants are cleared on session switch (todo is rebuilt by the caller)
		policyEngine.approvals.clear();
		// plan mode is session-scoped: its file path points into the OLD session's plan store, so plan-readonly
		// and the plan-file-write rule must not carry into the new session
		if (policyEngine.currentPlanMode || planService.current.active) {
			planService.exit();
			policyEngine.setPlanFilePath(undefined);
			policyEngine.setPlanMode(false);
		}
		if (policyEngine.currentScienceMode) {
			policyEngine.setScienceMode(false);
		}
		// the Stop-hook continuation budget is per prompt chain: the old session's used/pending flags would eat
		// the new session's single legitimate hook continuation
		stopHookContinuationUsed = false;
		stopHookContinuationPending = false;
		// compaction pending is the previous session's state: uncleared, every new-session prompt would spin
		// once on compaction
		turnController.clearCompactionPending();
		// the usage anchor belonged to the previous session's transcript: drop it (the next real request re-anchors)
		contextTracker.invalidate();
	};

	const kernel: Kernel = {
		agent,
		get model() {
			return model;
		},
		models,
		tools,
		get session() {
			return session;
		},
		get sessionId() {
			return currentSessionId;
		},
		sessions,
		events,
		trusted,
		get wasInterrupted() {
			return wasInterrupted;
		},
		get permissionMode() {
			return policyEngine.currentMode;
		},
		get planMode() {
			return policyEngine.currentPlanMode;
		},

		get scienceMode() {
			return policyEngine.currentScienceMode;
		},
		subagents,
		get approvalHandler() {
			return approvalHandler;
		},
		set approvalHandler(handler: ApprovalHandler | undefined) {
			approvalHandler = handler;
		},

		budgetState: () => turnController.budgetExhausted,
		injections: injection,
		get todos() {
			return todoStore.get();
		},
		get plan() {
			return planService.current;
		},
		usage: () => turnController.cumulativeUsage(),
		contextTokens: () => contextTracker.current(agent.state.messages),
		get contextWindow() {
			return effectiveContextWindow;
		},

		setPermissionMode(mode: PermissionMode) {
			// plan mode is orthogonal: only permission changes here, planService untouched
			policyEngine.setMode(mode);
			events.emit({ type: "permission_mode_changed", mode });
		},

		setPlanMode(on: boolean) {
			policyEngine.setPlanMode(on);
			if (on) {
				if (!planService.current.active) {
					// Same session-scoped path as the enter_plan_mode tool: /plan and the tool must
					// share one plan file, and off→on cycles keep reentry content (kimi semantics).
					const state = planService.enter(currentSessionId);
					policyEngine.setPlanFilePath(state.path);
				}
			} else if (planService.current.active) {
				planService.exit();
				policyEngine.setPlanFilePath(undefined);
			}
			events.emit({ type: "plan_mode_changed", on });
		},

		setScienceMode(on: boolean) {
			// science mode is read-only orchestration; it carries no plan-file identity (the science_plan tool writes artifacts)
			policyEngine.setScienceMode(on);
			events.emit({ type: "science_mode_changed", on });
		},

		setModel(spec: string) {
			model = resolveModel(models, spec);
			// model switch = new window: reset the overflow calibration, the new model re-learns its own ceiling
			effectiveContextWindow = model.contextWindow;
			turnController.updateContextWindow(model.contextWindow);
			agent.state.model = model;
			return model;
		},

		setThinking(level) {
			agent.state.thinkingLevel = level;
		},

		reloadCustomModels() {
			if (!trusted) return Promise.resolve([]);
			return registerCustomModels(cwd, models);
		},

		async compactNow(instruction?: string) {
			// re-entrancy guard: refuse while a run or a compaction is in flight, avoiding concurrent reads/writes of the agent transcript and session ledger
			if (activeRunId !== undefined || compacting > 0) return { applied: false, reason: "busy" };
			const outcome = await runCompactionWithEvents(session, undefined, "manual", instruction);
			return outcome.ok ? { applied: true } : { applied: false, reason: outcome.error };
		},

		isCompacting() {
			return compacting > 0;
		},

		reviewExec(command?: string) {
			return command === undefined ? undefined : execpolicyWarning(command, execPolicy);
		},
		reviewMobaiCommand(command: string) {
			// check_goal has no interactive approval: run the full policy chain, allow only on approve
			return policyEngine.evaluate({ toolName: "bash", args: { command }, kind: "exec", command }).verdict;
		},
		rememberApproval(req: ToolRequest) {
			policyEngine.approvals.remember(req);
		},
		async reloadPolicy() {
			// don't load project-level execpolicy in an untrusted directory (same gate as initial load)
			if (!trusted) return;
			execPolicy = await loadExecPolicy(cwd);
			policyEngine.reloadUserRules();
		},

		async newSession() {
			await settleActiveRun();
			// hook-observed order: old SessionEnd → new SessionStart (spawned sequentially; not after dispose)
			if (!disposed) hooks.fireAndForget("SessionEnd", { reason: "new" }, "new");
			const next = await sessions.create(modelSpecOf(model));
			const nextId = (await next.getMetadata()).id;
			await sessions.recordSystemPrompt(
				next,
				await buildSystemPromptText(cwd, memory.injectionText(), skills, options.headless),
			);
			applySessionSwitch(next, nextId);
			wasInterrupted = false;
			todoStore.set([]);
			if (!disposed) hooks.fireAndForget("SessionStart", { source: "new" }, "new");
			events.emit({ type: "session_switched", sessionId: nextId });
			return nextId;
		},

		async switchSession(metadata) {
			await settleActiveRun();
			// hook-observed order: old SessionEnd → new SessionStart (not fired after dispose)
			if (!disposed) hooks.fireAndForget("SessionEnd", { reason: "switch" }, "switch");
			const next = await sessions.open(metadata);
			const messages = await sessions.replay(next);
			applySessionSwitch(next, metadata.id);
			agent.state.messages = messages;
			wasInterrupted = (await sessions.interruptedRuns(next)).length > 0;
			const restoredTodos = foldProjection(todoEntryProjection, await sessions.entries(next));
			todoStore.set(restoredTodos ?? []);
			if (!disposed) hooks.fireAndForget("SessionStart", { source: "switch" }, "switch");
			events.emit({ type: "session_switched", sessionId: metadata.id });
		},

		async prompt(text: string) {
			// re-entrancy guard (asymmetric defense: existing callers are serial)
			if (activeRunId !== undefined) throw new Error("A run is already in progress");
			// UserPromptSubmit is the only hook that can intercept user input (exit 2 = reject).
			// Interception happens before the ledger write / run creation: the message isn't persisted and the
			// run isn't started
			const submit = await hooks.fireBlocking("UserPromptSubmit", { prompt: text }, text);
			if (submit.blocked) throw new HookBlockedError(submit.reason ?? "blocked by hook");
			const userMessage: Message = {
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			};
			await sessions.append(session, [userMessage]);
			// non-blocking UserPromptSubmit hook stdout joins the context as a reminder (e.g. an injector
			// appending project state on every prompt). Delivered through the steer queue so the LIVE order is
			// [user, reminder] — pi pushes the prompt's user message at loop start, before draining steering;
			// a direct appendReminderMessage push would land the reminder BEFORE it and diverge from the ledger.
			// The message_end handler persists it (steer-injected user message, not lastPromptedUser).
			if (submit.output) {
				agent.steer({
					role: "user",
					content: [{ type: "text", text: wrapSystemReminder(submit.output) }],
					timestamp: Date.now(),
				});
			}
			lastPromptedUser = userMessage;
			turnController.resetPrompt();

			// widened run scope: one run = agent.prompt() + the tail compaction/continue chain, with activeRunId held throughout.
			// capture the session/id at chain creation: switchSession/newSession may interleave between the chain's awaits,
			// so tail steps and settlement act only on the captured values and never touch the post-switch new session.
			const runSession = session;
			const runSessionId = currentSessionId;
			// a queued Stop continuation IS this prompt's first turn (drained at loop start): its chain keeps
			// the loop-guard state; only a prompt with no pending continuation starts a fresh budget
			if (!stopHookContinuationPending) stopHookContinuationUsed = false;
			stopHookContinuationPending = false;
			activeRunId = await sessions.startRun(runSession, [userMessage]);
			runOwnedByPrompt = true;
			runFinalized = false;
			lastRunOutcome = "completed";
			lastRunError = undefined;
			runAbort = new AbortController();
			events.emit({ type: "run_start", runId: activeRunId });

			let chainError: unknown;
			try {
				// pi's prompt() awaits the whole run lifecycle and returns once idle (the agent_end listener has already settled)
				await agent.prompt(userMessage);

				// closure read: agent_end mutates lastRunOutcome during the awaits below — a snapshot would freeze
				// TS control-flow narrowing at the pre-prompt "completed"
				const failedWithError = (): string | undefined => (lastRunOutcome === "failed" ? lastRunError : undefined);

				// Context-overflow recovery: a 400/413/422 "maximum context" error is a compaction signal, never a
				// session-killing first strike — without this the transcript stays oversized and EVERY later prompt
				// 400s again. Recovery = calibrate the observed window down (×0.85) + force compaction + continue;
				// MAX_OVERFLOW_COMPACTION_ATTEMPTS consecutive failures settle as a terminal error, and a surviving
				// continue resets the budget. Drained at every continue point below, not only the first prompt.
				const drainOverflowRecovery = async (): Promise<void> => {
					let consecutive = 0;
					while (currentSessionId === runSessionId) {
						const overflowError = failedWithError();
						if (overflowError === undefined || !isContextOverflowError(overflowError)) return;
						if (consecutive >= MAX_OVERFLOW_COMPACTION_ATTEMPTS) return;
						consecutive += 1;
						// observed-window self-calibration: the provider just told us the real ceiling
						const estimated = contextTracker.current(agent.state.messages);
						const observed = Math.floor(estimated * OVERFLOW_CONTEXT_SAFETY_RATIO);
						if (observed > 0 && (effectiveContextWindow === undefined || observed < effectiveContextWindow)) {
							effectiveContextWindow = observed;
							turnController.updateContextWindow(observed);
						}
						const outcome = await runCompactionWithEvents(runSession, runAbort?.signal, "auto");
						if (!outcome.ok || currentSessionId !== runSessionId) return;
						// pi continue() contract: the last message must be user or toolResult to resume. After an
						// overflow failure the tail is the error assistant — inject a persisted continuation
						// message so the compacted run can continue.
						const resume = agent.state.messages[agent.state.messages.length - 1] as AgentMessage | undefined;
						if (!resume || !("role" in resume) || (resume.role !== "toolResult" && resume.role !== "user")) {
							// the continuation is harness plumbing, never a user turn — replay/undo/export treat
							// it via isSystemReminderText
							const continuation: Message = {
								role: "user",
								content: [{ type: "text", text: wrapSystemReminder(OVERFLOW_CONTINUE_TEXT) }],
								timestamp: Date.now(),
							};
							await sessions.append(runSession, [continuation]);
							agent.state.messages = [...agent.state.messages, continuation];
						}
						await agent.continue();
						if (failedWithError() === undefined) consecutive = 0;
					}
				};
				await drainOverflowRecovery();

				let attempts = 0;
				let tookPending = false;
				while (currentSessionId === runSessionId && attempts < 3) {
					if (!turnController.takeCompactionPending()) break;
					tookPending = true;
					attempts += 1;
					const outcome = await runCompactionWithEvents(runSession, runAbort?.signal, "auto");
					if (!outcome.ok) break;
					// the session may have switched during compaction (settleActiveRun only waits for idle, not this chain): leave the agent transcript, don't continue
					if (currentSessionId !== runSessionId) break;
					// pi continue() contract: last message may be user or toolResult to resume (compaction's retained tail can end with an injected user message)
					const last = agent.state.messages[agent.state.messages.length - 1] as AgentMessage | undefined;
					if (!last || !("role" in last) || (last.role !== "toolResult" && last.role !== "user")) {
						// compaction applied but no resume point: the run ends here, pending is legitimately consumed
						tookPending = false;
						break;
					}
					await agent.continue();
					// the continue itself can hit the overflow wall (the tail grew since the last check): run the same
					// recovery as after the initial prompt instead of settling failed
					await drainOverflowRecovery();
					// this compaction has been consumed by a resume; if context is still over budget, evaluateTurnEnd will set pending again
					tookPending = false;
				}
				// took pending but the chain broke (compaction failure/session switch/attempts exhausted): return it so the next prompt re-triggers compaction
				if (tookPending) turnController.restoreCompactionPending();
			} catch (err) {
				chainError = err;
				throw err;
			} finally {
				// settle exactly once (runFinalized gate races the non-holding agent_end path)
				if (chainError !== undefined) {
					// Esc during the tail chain can surface as a thrown abort error: still an abort, not a failure
					const aborted =
						runAbort?.signal.aborted === true || (chainError instanceof Error && chainError.name === "AbortError");
					await finalizeRun(
						runSession,
						aborted ? "aborted" : "failed",
						aborted ? undefined : chainError instanceof Error ? chainError.message : String(chainError),
					);
				} else {
					// a cancelled tail compaction must settle the run as aborted, not completed — run_end completed
					// would trigger the TUI's auto-continue
					const tailAborted = runAbort?.signal.aborted === true;
					await finalizeRun(
						runSession,
						tailAborted ? "aborted" : lastRunOutcome,
						tailAborted ? undefined : lastRunError,
					);
				}
			}
		},

		steer(text: string) {
			// user input arriving mid-stream goes through steer queueing (doesn't interrupt the current turn): notification hook, not interceptable
			hooks.fireAndForget("UserPromptQueued", { prompt: text }, text);
			agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
		},

		async appendSystemReminder(text: string) {
			await appendReminderMessage(text);
		},

		abort() {
			// sample before abort: an idle programmatic abort must not fire a fake Interrupt event;
			// activeRunId covers the tail compaction chain, isStreaming an in-flight run
			const active = activeRunId !== undefined || agent.state.isStreaming;
			agent.abort();
			// during the tail compaction chain the agent is idle: also abort runAbort to break the in-flight
			// compaction summary LLM call
			runAbort?.abort();
			if (active) hooks.fireAndForget("Interrupt", { reason: "user_abort" });
		},

		mcpStatuses: () => mcpBridge.getStatuses(),
		jobs: localBackend,
		backends,
		humanJobs: humanBackend,

		watchJobs(onSettled: (event: JobWatcherEvent) => void) {
			// the watcher only notifies after the ledger is settled: the settle-before-hook discipline holds naturally
			const watcher = createJobWatcher(
				cwd,
				(event) => {
					fireJobFinished(event.jobId, event.backend, event.state);
					onSettled(event);
				},
				1500,
				// active settle-back polling: remote (ssh/slurm/modal) and human jobs settle themselves via
				// backend.status() instead of waiting for the next manual job_status call or a restart reclaim
				backends,
			);
			watcher.start();
			return { stop: () => watcher.stop() };
		},

		memory,

		async close() {
			await mcpBridge.close();
			memory.close();
		},

		async dispose() {
			// SessionEnd(exit) must finish before returning, or process exit kills the fire-and-forget child;
			// borrow fireBlocking's await (outcome ignored); not re-fired after dispose
			if (disposed) return;
			disposed = true;
			await hooks.fireBlocking("SessionEnd", { reason: "exit" }, "exit");
			// flush all in-flight fire-and-forget hooks (Stop/PostToolUse etc.); a headless process exit must not kill them
			await hooks.flush();
			await kernel.close();
		},
	};
	return kernel;
}

function modelSpecOf(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

// pi's steer queue is private; filter it in place, dropping ONLY reminder-class entries (identified via
// isSystemReminderText on the queued messages). Reach-in is read-shape-only and fails soft when pi renames it.
function dropQueuedReminders(target: Agent): void {
	const queue = (target as unknown as { steeringQueue?: { messages: AgentMessage[] } }).steeringQueue;
	if (!Array.isArray(queue?.messages)) return;
	queue.messages = queue.messages.filter((m) => !isReminderOnlyMessage(m));
}

function textOf(message: AgentMessage): string {
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && b.type === "text")
		.map((b) => b.text)
		.join("");
}

function thinkingOf(message: AgentMessage): string | undefined {
	if (!("content" in message) || !Array.isArray(message.content)) return undefined;
	const parts = message.content
		.filter(
			(b): b is { type: "thinking"; thinking: string } => typeof b === "object" && b !== null && b.type === "thinking",
		)
		.map((b) => b.thinking);
	return parts.length === 0 ? undefined : parts.join("");
}

const RESULT_PREVIEW_LIMIT = 2048;

export function resultTextOf(result: unknown): string {
	if (typeof result !== "object" || result === null) return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

export function resultPreviewOf(result: unknown): string {
	const text = resultTextOf(result);
	if (text.length <= RESULT_PREVIEW_LIMIT) return text;
	return `${text.slice(0, RESULT_PREVIEW_LIMIT)}…`;
}

export function resultDetailsOf(result: unknown): unknown {
	if (typeof result !== "object" || result === null) return undefined;
	return (result as { details?: unknown }).details;
}

async function buildSystemPromptText(
	cwd: string,
	memoryText: string,
	skills: Skill[],
	headless?: boolean,
): Promise<string> {
	return [
		await buildSystemPrompt(cwd, { headless }),
		...(memoryText
			? [
					[
						"Long-term project memory follows. These are verified facts persisted from earlier work;",
						"trust and build on them, but if live evidence contradicts a memory entry, prefer the live evidence and update the memory.",
						memoryText,
					].join("\n"),
				]
			: []),
		...(skills.length > 0
			? [
					[
						"The skills below are methodology playbooks, listed by scope priority (project skills override user skills, which override built-ins).",
						"Load a skill (read its file) only when the current task matches its description; do not preload them.",
						"Skills are guidance, not privileged instructions: they never override the scientific discipline or the user's requests.",
						formatSkillsForSystemPrompt(skills),
					].join("\n"),
				]
			: []),
	].join("\n\n");
}
