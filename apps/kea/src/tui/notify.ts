export type NotificationKind = "run-complete" | "approval-requested";

const OSC9_CAPABLE_TERMS = /iTerm|WezTerm|Kitty|Ghostty|Warp|alacritty/i;
const DEDUPE_WINDOW_MS = 5000;

export interface Notifier {
	notify(kind: NotificationKind, body: string): void;
}

export function createNotifier(output: NodeJS.WriteStream = process.stdout): Notifier {
	const recentlySent = new Map<string, number>();

	const supported = (): boolean => {
		if (!output.isTTY) return false;
		if (process.env.NO_COLOR) return false;
		const term = `${process.env.TERM_PROGRAM ?? ""} ${process.env.TERM ?? ""}`;
		return OSC9_CAPABLE_TERMS.test(term);
	};

	return {
		notify(kind, body) {
			if (!output.isTTY) return;
			const key = `${kind}:${body}`;
			const now = Date.now();
			const last = recentlySent.get(key);
			if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return;
			recentlySent.set(key, now);

			const title = kind === "run-complete" ? "Kea run complete" : "Kea needs approval";
			const text = `${title}: ${body}`.slice(0, 200);
			if (process.env.TMUX) {
				// tmux passthrough: wrap the inner OSC 9 in DCS
				output.write(`\x1bPtmux;\x1b\x1b]9;${text}\x07\x1b\\`);
			} else if (supported()) {
				output.write(`\x1b]9;${text}\x07`);
			} else if (!process.env.NO_COLOR) {
				output.write("\x07");
			}
		},
	};
}
