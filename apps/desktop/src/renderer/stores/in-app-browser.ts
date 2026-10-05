import { electronTrpcClient } from "renderer/lib/trpc-client";
import { opensInOdin } from "shared/in-odin-links";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The page the in-app browser is showing, or null while it's closed; whether
 * links skip it for your own browser (Settings → Connections, or "Always" on
 * the browser's "Open in browser" button); and the panel's width as a share of
 * the window, once you've dragged its edge (null = the default width).
 */
interface InAppBrowserState {
	url: string | null;
	external: boolean;
	widthFraction: number | null;
}

export const useInAppBrowser = create<InAppBrowserState>()(
	persist(
		(): InAppBrowserState => ({
			url: null,
			external: false,
			widthFraction: null,
		}),
		{
			name: "odin-in-app-browser",
			partialize: ({ external, widthFraction }) => ({
				external,
				widthFraction,
			}),
		},
	),
);

/**
 * Slack's `/archives/` link is a "Launching Slack" page that hands off to the
 * desktop app; `/messages/` is the same link in Slack's web client, which is
 * where that page's own "open this link in your browser" goes.
 */
export function slackWebClientUrl(url: string): string {
	return url.replace(
		/^(https:\/\/[\w.-]+\.slack\.com)\/archives\//i,
		"$1/messages/",
	);
}

export interface SlackThread {
	workspace: string;
	channel: string;
	threadTs: string;
	replyTs: string;
}

/**
 * The thread a Slack message link points into: the message itself
 * (`/archives/C123/p1700000000123456`) heads its own thread, and a reply's
 * link names its thread in `thread_ts`. Null for any other link.
 */
export function slackThread(url: string): SlackThread | null {
	const match = url.match(
		/^https:\/\/([\w-]+)\.slack\.com\/(?:archives|messages)\/(\w+)\/p(\d+)(\d{6})(?:[/?#]|$)/i,
	);
	if (!match) return null;
	const [, workspace = "", channel = "", seconds, micros] = match;
	const replyTs = `${seconds}.${micros}`;
	const threadTs = new URL(url).searchParams.get("thread_ts") ?? replyTs;
	return { workspace, channel, threadTs, replyTs };
}

/**
 * Opens a task source's link (a Slack thread, a Jira ticket) inside Odin, in
 * the slide-over browser, so it doesn't throw you out to another app - unless
 * you chose your own browser. Any other link, and anything that isn't a web
 * page (mailto:, a file), goes to the system.
 */
export function openUrl(url: string): void {
	if (opensInOdin(url) && !useInAppBrowser.getState().external) {
		useInAppBrowser.setState({ url: slackWebClientUrl(url) });
		return;
	}
	electronTrpcClient.external.openUrl.mutate(url).catch((error) => {
		console.error("[openUrl] Failed to open URL:", url, error);
	});
}
