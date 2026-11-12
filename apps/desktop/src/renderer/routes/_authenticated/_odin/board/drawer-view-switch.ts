/**
 * Which view the drawer footer offers: "chat" (the Chat View button),
 * "terminal" (Terminal View) or null (none - the chat shows, and its composer
 * has Terminal View).
 *
 * The ▣ View tab covers the session the way the diff does, and the chat's
 * composer with it, so there was no way back but knowing ▣ View toggles.
 * While the app shows, the footer names the view under it - the one last
 * used - and its click only takes the app off screen, leaving the setting be.
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
	const under = chat && !peeking ? "chat" : "terminal";
	if (hostScreenOpen) return under;
	return under === "terminal" ? "chat" : null;
}
