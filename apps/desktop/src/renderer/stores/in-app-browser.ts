import { electronTrpcClient } from "renderer/lib/trpc-client";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The page the in-app browser is showing, or null while it's closed, and
 * whether links skip it for your own browser (Settings → Connections, or
 * "Always" on the browser's "Open in browser" button).
 */
interface InAppBrowserState {
	url: string | null;
	external: boolean;
}

export const useInAppBrowser = create<InAppBrowserState>()(
	persist((): InAppBrowserState => ({ url: null, external: false }), {
		name: "odin-in-app-browser",
		partialize: ({ external }) => ({ external }),
	}),
);

/**
 * Opens a link inside Odin, in the slide-over browser, so a Slack thread or a
 * Jira ticket doesn't throw you out to another app — unless you chose your own
 * browser. Anything that isn't a web page (mailto:, a file) goes to the system.
 */
export function openUrl(url: string): void {
	if (/^https?:\/\//i.test(url) && !useInAppBrowser.getState().external) {
		useInAppBrowser.setState({ url });
		return;
	}
	electronTrpcClient.external.openUrl.mutate(url).catch((error) => {
		console.error("[openUrl] Failed to open URL:", url, error);
	});
}
