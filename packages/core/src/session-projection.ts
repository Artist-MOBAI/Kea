// Session projection: derive live snapshots from the durable session stream as pure folds. init() seeds the
// fold state, apply() folds one event at a time, view() derives the snapshot; state is re-derived and never
// stored separately, so projections survive replay/compaction like the log itself. mobai / plan / todo share
// this substrate — several projections over the same stream compose without importing each other.

export interface Projection<State, Event, View> {
	readonly name: string;
	init(): State;
	apply(event: Event, state: State): State;
	view(state: State): View;
}

// Fold one projection over the whole stream in a single pass (no side effects, no shared mutable state).
export function foldProjection<State, Event, View>(
	projection: Projection<State, Event, View>,
	events: readonly Event[],
): View {
	let state = projection.init();
	for (const event of events) {
		state = projection.apply(event, state);
	}
	return projection.view(state);
}
