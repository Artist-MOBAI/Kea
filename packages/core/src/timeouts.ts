// Timeout budget table — the single place where wall-clock ceilings live. Every consumer imports from here so
// the numbers can be reasoned about as one budget.

/** Model stream idle watchdog: a stream producing no events for this long is treated as a hung socket. */
export const STREAM_IDLE_TIMEOUT_MS = 600_000;

/** Machine-acceptance / criterion command ceiling (a full Lean build or training run must fit). */
export const ACCEPTANCE_TIMEOUT_S = 3600;

/** bash tool default when the model passes no explicit timeout. */
export const BASH_DEFAULT_TIMEOUT_S = 300;

/** bash tool hard ceiling (longer work belongs to the jobs system). */
export const BASH_MAX_TIMEOUT_S = 3600;

/** Two-step confirmation window for destructive UX confirmations (e.g. /mobai cancel). */
export const CONFIRM_WINDOW_MS = 30_000;

/** Shared cap for tool result text (built-in tools, MCP, web, job logs). */
export const MAX_TOOL_RESULT_CHARS = 50_000;

/** Job wall-clock default when a submit passes no explicit timeout (schema default and backends). */
export const JOB_DEFAULT_TIMEOUT_MS = 30 * 60_000;

/** job_status tail for streamed/settled stderr and running-local logs. */
export const JOB_LOG_TAIL_CHARS = 2_000;

/** job_status tail for a settled job's stdout (the result payload being polled for). */
export const JOB_RESULT_TAIL_CHARS = 4_000;

/** Subagent wall-clock budget: default for spawned agents (profiles may override with named entries below). */
export const SUBAGENT_DEFAULT_WALL_CLOCK_MS = 10 * 60_000;

/** Built-in profile budgets: reader/judge are quick read-only lookups; planner's covers waiting on nested readers. */
export const SUBAGENT_READER_WALL_CLOCK_MS = 5 * 60_000;
export const SUBAGENT_WRITER_WALL_CLOCK_MS = 10 * 60_000;
export const SUBAGENT_PLANNER_WALL_CLOCK_MS = 40 * 60_000;
export const SUBAGENT_JUDGE_WALL_CLOCK_MS = 5 * 60_000;
