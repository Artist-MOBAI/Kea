// The opener for every harness-spawned worker that must not inherit the parent conversation;
// one export so the call sites never drift apart
export const FRESH_WORKER_PREAMBLE =
	"You are one fresh worker. You receive no parent conversation and no prior child session.";
