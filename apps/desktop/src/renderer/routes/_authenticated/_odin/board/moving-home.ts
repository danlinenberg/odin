/** A message sent while its session moves from the remote host to this computer. */
export type HeldMessage = {
	text: string;
	/** It went out with the resume: the bubble stops saying it waits. */
	sent: () => void;
	/** The move failed: the bubble says Not delivered. */
	lost: () => void;
};

/**
 * Sessions on their way from the remote host to this computer, each with the
 * messages sent meanwhile. Typed into the pane, they reached the host's
 * Claude after its conversation was copied, or the connect step of a pane
 * about to be killed, and never arrived anywhere. Held here, they ride on the
 * resume here instead.
 */
const moving = new Map<string, HeldMessage[]>();

export function startMove(paneId: string): void {
	moving.set(paneId, []);
}

export const isMoving = (paneId: string): boolean => moving.has(paneId);

/** Holds `message` for the resume if the pane is moving; false if it isn't. */
export function holdForMove(paneId: string, message: HeldMessage): boolean {
	const held = moving.get(paneId);
	if (!held) return false;
	held.push(message);
	return true;
}

/** The move is over: what was held, oldest first. */
export function endMove(paneId: string): HeldMessage[] {
	const held = moving.get(paneId) ?? [];
	moving.delete(paneId);
	return held;
}

/** The resume's opening: the move note, then each held message. */
export const withHeld = (note: string, held: HeldMessage[]): string =>
	[note, ...held.map((message) => message.text)].join("\n\n");
