import { electronTrpcClient } from "renderer/lib/trpc-client";
import { create } from "zustand";

/** The page the in-app browser is showing, or null while it's closed. */
export const useInAppBrowser = create<{ url: string | null }>(() => ({
	url: null,
}));

/**
 * Opens a link inside Odin, in the slide-over browser, so a Slack thread or a
 * Jira ticket doesn't throw you out to another app. Anything that isn't a web
 * page (mailto:, a file) still goes to the system.
 */
export function openUrl(url: string): void {
	if (/^https?:\/\//i.test(url)) {
		useInAppBrowser.setState({ url });
		return;
	}
	electronTrpcClient.external.openUrl.mutate(url).catch((error) => {
		console.error("[openUrl] Failed to open URL:", url, error);
	});
}
