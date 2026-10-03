/**
 * The Get started checklist's rules, apart from its UI so they can be tested.
 *
 * Order is the order a new profile needs them in: accounts first (every feed
 * is empty without one), then a task of your own, then the things you do with
 * tasks — run one, schedule one, clear the backlog.
 */
export const STEPS = [
	"connections",
	"task",
	"session",
	"automation",
	"review",
] as const;
export type StepId = (typeof STEPS)[number];

interface Connection {
	configured: boolean;
	error: string | null;
}

/**
 * A profile nobody has used yet: no account signed in, nothing written down.
 * Only these get the checklist — a profile already in use would get a card
 * full of ticks telling it what it already knows.
 */
export function isFreshProfile(
	connections: Connection[],
	todoCount: number,
): boolean {
	return todoCount === 0 && !connections.some((c) => c.configured);
}

/** The steps the profile's current state already satisfies. */
export function satisfiedSteps(state: {
	connections: Connection[] | undefined;
	todoCount: number;
	sessionCount: number;
	/** Built-ins arrive pre-installed, so only ones you wrote count. */
	ownAutomationCount: number;
	onReview: boolean;
}): StepId[] {
	const met: Record<StepId, boolean> = {
		connections: !!state.connections?.some((c) => c.configured && !c.error),
		task: state.todoCount > 0,
		session: state.sessionCount > 0,
		automation: state.ownAutomationCount > 0,
		review: state.onReview,
	};
	return STEPS.filter((step) => met[step]);
}
