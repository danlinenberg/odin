/**
 * Moves a session to VS Code in the one safe order: the folder opens first,
 * and only once it did is the Odin session closed and the conversation sent
 * over. A folder that fails to open leaves the session running here.
 */
export async function moveToVsCode(steps: {
	openFolder: () => Promise<void>;
	/** Set when the conversation moves: closes it in Odin, then sends it. */
	move?: {
		closeHere: () => Promise<void>;
		sendSession: () => Promise<boolean>;
	};
}): Promise<
	{ opened: false; error: unknown } | { opened: true; inPanel: boolean }
> {
	try {
		await steps.openFolder();
	} catch (error) {
		return { opened: false, error };
	}
	if (!steps.move) return { opened: true, inPanel: false };
	await steps.move.closeHere();
	const inPanel = await steps.move.sendSession().catch(() => false);
	return { opened: true, inPanel };
}
