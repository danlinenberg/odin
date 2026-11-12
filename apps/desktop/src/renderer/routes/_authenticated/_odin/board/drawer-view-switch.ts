/**
 * Which view the drawer footer offers to switch to: "chat" (the Chat View
 * button), "terminal" (Terminal View) or null (none - the chat shows, and its
 * composer has Terminal View).
 *
 * The ▣ View tab covers the session the way the diff does, and with it the
 * chat's composer, so Terminal View went with it: with the app on screen there
 * was no way to the terminal but knowing ▣ View toggles back (and the footer's
 * Chat View did nothing you could see). While the app shows, the footer offers
 * Terminal View, which takes the app off screen.
 */
export function drawerViewSwitch({
	chat,
	peeking,
	hostScreenOpen,
}: {
	/** Settings > Appearance: sessions show as a chat. */
	chat: boolean;
	/** The chat is set, but this session shows its terminal (a question peek). */
	peeking: boolean;
	/** The ▣ View tab shows the app the session runs on its host. */
	hostScreenOpen: boolean;
}): "chat" | "terminal" | null {
	if (hostScreenOpen) return "terminal";
	return !chat || peeking ? "chat" : null;
}
