// Shared UI symbols. BMP only, no emoji — fallback rendering and width instability in terminals.
// Marker widths must stay stable: wrapping and card rendering assume a fixed leading column width.
// New symbols go here first; no scattering literals across components.

export const SUCCESS_MARK = "✓";
export const FAILURE_MARK = "✗";
export const SELECT_POINTER = "❯";
/** End-of-line mark for the currently active value in a picker (distinct from ✓'s success semantics). */
export const CURRENT_MARK = "← current";
export const STATUS_BULLET = "●";
export const RUNNING_MARK = "▶";
export const AWAITING_MARK = "!";
export const PENDING_MARK = "○";
/** Message branch bullet: rendered against the card border as an ├─ shape. */
export const BRANCH_BULLET = "─ ";
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
/** Masked input placeholder: always width 1, repeated by visible width; the real value never reaches the screen. */
export const MASK_CHAR = "•";
