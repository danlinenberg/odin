import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@odin/ui/dropdown-menu";
import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import type { WebviewTag } from "electron";
import { useEffect, useRef, useState } from "react";
import {
	HiArrowLeft,
	HiArrowPath,
	HiArrowRight,
	HiArrowTopRightOnSquare,
	HiChevronDown,
	HiXMark,
} from "react-icons/hi2";
import { useZoomFactor } from "renderer/hooks/useZoomFactor";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	slackWebClientUrl,
	useInAppBrowser,
} from "renderer/stores/in-app-browser";
import { IN_APP_BROWSER_PARTITION } from "shared/constants";
import { BUTTON } from "./pill";

const CHROME_MAJOR = navigator.userAgent.match(/Chrome\/(\d+)/)?.[1];

/**
 * Plain Chrome's user agent. Google turns away sign-ins from browsers it can
 * tell are embedded, and Slack's and Jira's SSO both go through it.
 */
const USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

const close = () => useInAppBrowser.setState({ url: null });

/** From now on links skip this panel; Undo, or Settings → Connections, brings it back. */
const alwaysExternal = () => {
	useInAppBrowser.setState({ external: true });
	toast("Links now open in your browser", {
		description: "Switch back in Settings → Connections.",
		action: {
			label: "Undo",
			onClick: () => useInAppBrowser.setState({ external: false }),
		},
	});
};

/** What a page in the panel logs when Esc goes unhandled there. */
const ESCAPE_SIGNAL = "odin:in-app-browser:escape";

/**
 * A page in the panel is its own document, so its keys never reach Odin's
 * window. It reports an Esc it didn't use itself (a Jira modal closing takes
 * it) through its console instead. Slack's web client prevents every Esc,
 * open menu or not, so an Esc the page took still counts when nothing was
 * open for it to close. Checked in the capture phase, before the page's own
 * handlers close whatever was open.
 */
const REPORT_ESCAPE = `addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	const open = [...document.querySelectorAll("[role=dialog],[role=menu],[role=listbox],[aria-modal=true]")]
		.some((el) => el.getClientRects().length > 0);
	setTimeout(() => {
		if (!event.defaultPrevented || !open) console.debug(${JSON.stringify(ESCAPE_SIGNAL)});
	});
}, true);`;

const ICON_BUTTON =
	"flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground";

/**
 * Where Odin's links open: a panel over the page, instead of another app. A
 * <webview>, not an iframe, because Slack, Jira, GitHub and Notion all refuse
 * to be framed. It keeps its own persistent session, so you sign in to each
 * site once and stay signed in, and none of their cookies reach Odin's.
 */
export function InAppBrowser() {
	const url = useInAppBrowser((state) => state.url);
	const openExternal = electronTrpc.external.openUrl.useMutation();
	const view = useRef<WebviewTag>(null);
	const [page, setPage] = useState({ title: "", url: "" });
	const zoomFactor = useZoomFactor();

	// A <webview> keeps its own zoom: it starts at 100% whatever Odin's zoom
	// is, and Chromium resets it per site. So it takes Odin's on every
	// navigation, and again whenever Odin's changes.
	useEffect(() => {
		const webview = view.current;
		if (!url || !webview) return;
		const apply = () => webview.setZoomFactor(zoomFactor);
		try {
			apply();
		} catch {
			// Not attached yet; its first did-navigate applies it.
		}
		webview.addEventListener("did-navigate", apply);
		return () => {
			webview.removeEventListener("did-navigate", apply);
		};
	}, [url, zoomFactor]);

	useEffect(() => {
		const webview = view.current;
		if (!url || !webview) return;
		// Whatever had focus when the link opened — the session's terminal,
		// Catch up — gets it back on close, instead of it falling to <body>.
		const opener = document.activeElement;
		setPage({ title: "", url });
		const onNavigate = (event: Event) =>
			setPage((prev) => ({
				...prev,
				url: (event as { url?: string }).url ?? prev.url,
			}));
		const onTitle = (event: Event) =>
			setPage((prev) => ({
				...prev,
				title: (event as { title?: string }).title ?? "",
			}));
		// Captured and stopped at the window: Esc closes the panel and nothing
		// under it — not the session drawer, not Catch up, not the terminal.
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// The "Open in browser" menu closes itself first.
			if ((event.target as HTMLElement | null)?.closest("[role=menu]")) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			close();
		};
		const onReady = () => {
			webview.executeJavaScript(REPORT_ESCAPE).catch(() => {});
		};
		const onConsole = (event: Event) => {
			if ((event as { message?: string }).message === ESCAPE_SIGNAL) close();
		};
		// A Slack link followed inside the panel (from a Jira ticket, a Notion
		// page, a sign-in redirect) goes to Slack's web client before Slack's
		// desktop hand-off page can load, as openUrl does for Odin's own links.
		const toSlackWebClient = (event: {
			url: string;
			isMainFrame: boolean;
			isInPlace: boolean;
		}) => {
			const web = slackWebClientUrl(event.url);
			if (event.isMainFrame && !event.isInPlace && web !== event.url) {
				webview.loadURL(web).catch(() => {});
			}
		};
		webview.addEventListener("did-navigate", onNavigate);
		webview.addEventListener("did-navigate-in-page", onNavigate);
		webview.addEventListener("page-title-updated", onTitle);
		webview.addEventListener("dom-ready", onReady);
		webview.addEventListener("console-message", onConsole);
		webview.addEventListener("did-start-navigation", toSlackWebClient);
		webview.addEventListener("did-redirect-navigation", toSlackWebClient);
		window.addEventListener("keydown", onKey, { capture: true });
		return () => {
			webview.removeEventListener("did-navigate", onNavigate);
			webview.removeEventListener("did-navigate-in-page", onNavigate);
			webview.removeEventListener("page-title-updated", onTitle);
			webview.removeEventListener("dom-ready", onReady);
			webview.removeEventListener("console-message", onConsole);
			webview.removeEventListener("did-start-navigation", toSlackWebClient);
			webview.removeEventListener("did-redirect-navigation", toSlackWebClient);
			window.removeEventListener("keydown", onKey, { capture: true });
			if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
		};
	}, [url]);

	if (!url) return null;

	return (
		<>
			<button
				type="button"
				aria-label="Close browser"
				className="absolute inset-0 z-[60] cursor-default bg-black/35"
				onClick={close}
			/>
			<div className="absolute inset-y-0 right-0 z-[60] flex w-[min(1200px,92%)] flex-col border-l border-border bg-background shadow-2xl">
				<div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
					<button
						type="button"
						title="Back"
						className={ICON_BUTTON}
						onClick={() => view.current?.goBack()}
					>
						<HiArrowLeft className="size-4" />
					</button>
					<button
						type="button"
						title="Forward"
						className={ICON_BUTTON}
						onClick={() => view.current?.goForward()}
					>
						<HiArrowRight className="size-4" />
					</button>
					<button
						type="button"
						title="Reload"
						className={ICON_BUTTON}
						onClick={() => view.current?.reload()}
					>
						<HiArrowPath className="size-4" />
					</button>
					<span
						title={page.url}
						className="min-w-0 flex-1 truncate px-2 text-[13px] text-muted-foreground"
					>
						{page.title || new URL(page.url || url).host}
					</span>
					<div className="flex">
						<button
							type="button"
							title="Open in your browser"
							onClick={() => {
								openExternal.mutate(page.url || url);
								close();
							}}
							className={cn(
								"flex items-center gap-1.5 rounded-l-md px-2.5 py-1 text-xs font-medium",
								BUTTON.secondary,
							)}
						>
							<HiArrowTopRightOnSquare className="size-3.5" />
							Open in browser
						</button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									aria-label="More ways to open"
									className={cn(
										"-ml-px flex items-center rounded-r-md px-1.5",
										BUTTON.secondary,
									)}
								>
									<HiChevronDown className="size-3.5" />
								</button>
							</DropdownMenuTrigger>
							{/* Above the panel's z-[60]. */}
							<DropdownMenuContent align="end" className="z-[70]">
								<DropdownMenuItem
									onSelect={() => {
										openExternal.mutate(page.url || url);
										close();
										alwaysExternal();
									}}
								>
									<HiArrowTopRightOnSquare className="size-3.5" />
									Always open links in your browser
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
					<button
						type="button"
						title="Close (Esc)"
						className={ICON_BUTTON}
						onClick={close}
					>
						<HiXMark className="size-4" />
					</button>
				</div>
				<webview
					ref={view}
					src={url}
					partition={IN_APP_BROWSER_PARTITION}
					// No passkeys: Electron can't show the Touch ID prompt, so a site
					// asking for one (Google does) waits forever. Without WebAuthn it
					// offers your phone or password instead.
					disableblinkfeatures="WebAuth"
					useragent={USER_AGENT}
					// Only read as present or absent; React drops a boolean `true` on
					// an attribute it doesn't know, so it has to be a string.
					allowpopups={"true" as unknown as boolean}
					className="min-h-0 flex-1"
				/>
			</div>
		</>
	);
}
