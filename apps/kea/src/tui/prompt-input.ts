import { type Component, type Focusable, Input, truncateToWidth } from "@earendil-works/pi-tui";
import { FAILURE_MARK, MASK_CHAR } from "./constants/symbols.ts";

// Single-line question component on pi-tui Input: adds only question/hint/placeholder/mask/validate —
// editing behavior (kill-ring, undo, paste, cursor movement, IME) is Input's, never rebuilt here.

// Masked input: during render the real value is temporarily replaced with a fixed-width MASK_CHAR and
// never reaches the screen. pi-tui's Input declares value/cursor private in .d.ts but the compiled
// output is plain public JS; this minimal cast touches only `value` — API keys are ASCII, so masked
// and real lengths match and cursor/scroll stay aligned.
class MaskedInput extends Input {
	override render(width: number): string[] {
		const self = this as unknown as { value: string };
		const real = self.value;
		self.value = MASK_CHAR.repeat(Array.from(real).length);
		try {
			return super.render(width);
		} finally {
			// Restore the real value even if super.render throws, or the next submit sends the mask itself.
			self.value = real;
		}
	}
}

export interface PromptStepOptions {
	question: string;
	placeholder?: string;
	masked?: boolean;
	hint?: string;
	/** Returning undefined = pass; otherwise an error message shown inline, editing continues. */
	validate?: (value: string) => string | undefined;
	initial?: string;
}

export interface PromptStepCallbacks {
	onSubmit: (value: string) => void;
	onCancel: () => void;
}

export class PromptStep implements Component, Focusable {
	private readonly input: Input;
	private error = "";
	private _focused = false;

	constructor(
		private readonly opts: PromptStepOptions,
		private readonly callbacks: PromptStepCallbacks,
		// dim decoration for the hint line (the component does not reach the theme directly)
		private readonly dim: (s: string) => string = (s) => s,
	) {
		this.input = opts.masked ? new MaskedInput() : new Input();
		if (opts.initial !== undefined) this.input.setValue(opts.initial);
		this.input.onSubmit = (value) => this.submit(value);
		this.input.onEscape = () => this.callbacks.onCancel();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	getValue(): string {
		return this.input.getValue();
	}

	private submit(value: string): void {
		const trimmed = value.trim();
		if (this.opts.validate) {
			const problem = this.opts.validate(trimmed);
			if (problem !== undefined) {
				this.error = problem;
				return;
			}
		}
		this.error = "";
		this.callbacks.onSubmit(trimmed);
	}

	render(width: number): string[] {
		const lines: string[] = [this.opts.question];
		if (this.opts.hint !== undefined) {
			for (const hintLine of this.opts.hint.split("\n")) lines.push(this.dim(hintLine));
		}
		lines.push(...this.input.render(width));
		if (this.opts.placeholder !== undefined && this.input.getValue() === "") {
			lines.push(this.dim(`  (${this.opts.placeholder})`));
		}
		if (this.error !== "") lines.push(`${FAILURE_MARK} ${this.error}`);
		lines.push("Enter to continue · Esc to cancel");
		// pi-tui crashes hard on over-wide lines and dialog mounts have no width guard: clamp every line.
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.input.invalidate();
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}
