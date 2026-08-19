import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { type Subprocess, spawn } from "bun";

// PTY e2e helper: python3 pty.fork drives the Kea CLI (no native deps); the bridge pipes the pty
// master to its stdio. On SIGTERM/SIGINT it reaps the CLI child before exiting so no orphan bun
// processes accumulate (Bun.spawn exposes no setpgrp, so signals are the fallback).
const BRIDGE_SCRIPT = `
import os, pty, select, signal, sys
cli = sys.argv[1]
workdir = sys.argv[2]
rows = int(sys.argv[3])
cols = int(sys.argv[4])
rest = sys.argv[5:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(workdir)
    os.execvp("bun", ["bun", "run", cli, *rest])
def kill_child():
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
def on_signal(signum, frame):
    kill_child()
    os._exit(143)
signal.signal(signal.SIGTERM, on_signal)
signal.signal(signal.SIGINT, on_signal)
import fcntl, struct, termios
try:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
except Exception:
    pass
stdin_fd = sys.stdin.fileno()
os.set_blocking(stdin_fd, False)
while True:
    try:
        r, _, _ = select.select([fd, stdin_fd], [], [], 0.1)
    except (OSError, ValueError):
        break
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    if stdin_fd in r:
        try:
            data = os.read(stdin_fd, 65536)
        except (BlockingIOError, InterruptedError):
            continue
        except OSError:
            break
        if not data:
            break
        try:
            os.write(fd, data)
        except OSError:
            break
# Loop exit (EOF/error) still kills the child as a fallback, then waitpid reaps it to avoid zombies
kill_child()
try:
    os.waitpid(pid, 0)
except OSError:
    pass
`;

export interface KeaPtyOptions {
	cwd: string;
	cliPath: string;
	args?: string[];
	env?: Record<string, string>;
	rows?: number;
	cols?: number;
}

export interface KeaPty {
	write(text: string): void;
	/** Wait until the target text appears in output (matched against ANSI-stripped text) */
	waitForText(needle: string, timeoutMs?: number): Promise<boolean>;
	/** Current accumulated output (ANSI-stripped) */
	text(): string;
	rawOutput(): string;
	kill(): void;
}

/** kill() grace window: time to wait for the bridge to exit after SIGTERM before falling back to SIGKILL. */
const KILL_GRACE_MS = 1500;

export function spawnKeaPty(options: KeaPtyOptions): KeaPty {
	const rows = options.rows ?? 30;
	const cols = options.cols ?? 100;
	const env: Record<string, string | undefined> = {
		...process.env,
		TERM: "xterm-256color",
		...(options.env ?? {}),
	};
	delete env.NO_COLOR;

	const proc: Subprocess = spawn(
		["python3", "-c", BRIDGE_SCRIPT, options.cliPath, options.cwd, String(rows), String(cols), ...(options.args ?? [])],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env,
		},
	);

	let raw = "";
	const stdout = proc.stdout;
	if (stdout && typeof stdout !== "number") {
		const reader = stdout.getReader();
		void (async () => {
			const decoder = new TextDecoder("utf-8", { fatal: false });
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				raw += decoder.decode(value, { stream: true });
			}
		})().catch(() => {});
	}
	// stderr must be drained continuously: a full 64KB pipe buffer (python tracebacks, etc.) would block the bridge loop and deadlock
	const stderr = proc.stderr;
	if (stderr && typeof stderr !== "number") {
		const errReader = stderr.getReader();
		void (async () => {
			for (;;) {
				const { done } = await errReader.read();
				if (done) break;
			}
		})().catch(() => {});
	}

	return {
		write(text: string) {
			// Writes after the process has exited are silently ignored (common during test teardown)
			try {
				const stdin = proc.stdin;
				if (!stdin || typeof stdin === "number") return;
				stdin.write(new TextEncoder().encode(text));
				const flushed = stdin.flush();
				if (typeof flushed !== "number") flushed.catch(() => {});
			} catch {}
		},
		async waitForText(needle: string, timeoutMs = 30_000): Promise<boolean> {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (stripTerminalSequences(raw).includes(needle)) return true;
				await Bun.sleep(150);
			}
			return stripTerminalSequences(raw).includes(needle);
		},
		text: () => stripTerminalSequences(raw),
		rawOutput: () => raw,
		kill() {
			try {
				proc.kill();
			} catch {}
			void (async () => {
				const exited = await Promise.race([proc.exited, Bun.sleep(KILL_GRACE_MS).then(() => undefined)]);
				if (exited === undefined) {
					try {
						proc.kill("SIGKILL");
					} catch {}
				}
			})();
		},
	};
}

export const KEA_CLI_PATH = new URL("../../src/cli.ts", import.meta.url).pathname;
