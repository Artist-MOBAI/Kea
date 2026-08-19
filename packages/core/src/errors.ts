export type KeaErrorCode = "model-resolution" | "session" | "compaction" | "config" | "internal";

export class KeaError extends Error {
	readonly code: KeaErrorCode;

	constructor(code: KeaErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "KeaError";
		this.code = code;
	}
}

export class ModelResolutionError extends KeaError {
	constructor(message: string) {
		super("model-resolution", message);
		this.name = "ModelResolutionError";
	}
}

export class SessionError extends KeaError {
	constructor(message: string, options?: { cause?: unknown }) {
		super("session", message, options);
		this.name = "SessionError";
	}
}

/** "file does not exist" classification for single-read guards (existsSync+read pairs collapse into one read). */
export function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T>(error: string): Result<T> => ({ ok: false, error });
