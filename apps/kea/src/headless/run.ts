import { HookBlockedError, type Kernel, runTurnWithTransientRetry } from "@kea/core";
import { FAILURE_MARK } from "../tui/constants/symbols.ts";
import { hookBlockedMessage } from "../tui/controllers/error-classify.ts";

export interface RunOptions {
	prompt: string;

	format: "text" | "ndjson";
}

export async function runHeadless(kernel: Kernel, options: RunOptions): Promise<number> {
	const ndjson = options.format === "ndjson";
	const emit = (obj: Record<string, unknown>) => {
		if (ndjson) console.log(JSON.stringify(obj));
	};

	let finalText = "";
	let sawError = false;

	const unsubscribe = kernel.events.subscribe((event) => {
		switch (event.type) {
			case "message_start": {
				// core's message_delta text is cumulative PER MESSAGE, not across messages: reset so a new
				// assistant message streams its full text instead of diffing against the previous message's tail
				if ("role" in event.message && event.message.role === "assistant") finalText = "";
				break;
			}
			case "message_delta": {
				if (!("role" in event.message) || event.message.role !== "assistant") break;
				if (!ndjson && event.text.length > finalText.length && event.text.startsWith(finalText)) {
					process.stdout.write(event.text.slice(finalText.length));
				}
				finalText = event.text;
				emit({ type: "message_update", role: "assistant", text: event.text });
				break;
			}
			case "message_end": {
				if (!("role" in event.message) || event.message.role !== "assistant") break;
				if (!ndjson) {
					if (!event.text.startsWith(finalText)) process.stdout.write(event.text);
					process.stdout.write("\n");
				}
				finalText = event.text;
				emit({ type: "message_end", role: "assistant", text: event.text });
				break;
			}
			case "tool_start":
				if (!ndjson) console.error(`→ ${event.name}`);
				emit({ type: event.type, tool: event.name, args: event.args });
				break;
			case "tool_end":
				if (!ndjson && event.isError) console.error(`  ${FAILURE_MARK} ${event.name} failed`);
				emit({ type: event.type, tool: event.name, isError: event.isError, durationMs: event.durationMs });
				break;
			case "run_end":
				if (event.outcome === "failed" && event.error) sawError = true;
				break;
			default:
				break;
		}
	});

	let blocked: HookBlockedError | undefined;
	let transientError: string | undefined;
	try {
		// one task = one turn; a mid-stream socket drop is retried with a continuation prompt (up to 5 backoff attempts)
		const host = {
			prompt: (text: string) => kernel.prompt(text),
			waitForIdle: () => kernel.agent.waitForIdle(),
			errorMessage: () => kernel.agent.state.errorMessage,
		};
		const outcome = await runTurnWithTransientRetry(host, options.prompt);
		transientError = outcome.error;
	} catch (err) {
		// Hook block (UserPromptSubmit exit 2): report on stderr + exit code 1; other errors keep propagating
		if (err instanceof HookBlockedError) blocked = err;
		else throw err;
	} finally {
		// Unsubscribe even when the prompt is rejected, so later events (during close) do not keep firing this handler
		unsubscribe();
	}

	if (blocked) {
		const message = hookBlockedMessage(blocked.reason);
		if (ndjson) console.log(JSON.stringify({ type: "error", message }));
		else console.error(`error: ${message}`);
		return 1;
	}

	if (transientError) {
		sawError = true;
		if (ndjson) console.log(JSON.stringify({ type: "error", message: transientError }));
		else console.error(`error: ${transientError}`);
	}
	return sawError ? 1 : 0;
}
