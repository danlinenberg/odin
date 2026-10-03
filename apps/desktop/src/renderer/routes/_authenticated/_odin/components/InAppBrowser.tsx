import { cn } from "@odin/ui/utils";
import type { WebviewTag } from "electron";
import { useEffect, useRef, useState } from "react";
import {
	HiArrowLeft,
	HiArrowPath,
	HiArrowRight,
	HiArrowTopRightOnSquare,
	HiXMark,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useInAppBrowser } from "renderer/stores/in-app-browser";
import { IN_APP_BROWSER_PARTITION } from "shared/constants";
import { BUTTON } from "./pill";

const CHROME_MAJOR = navigator.userAgent.match(/Chrome\/(\d+)/)?.[1];

/**
 * Plain Chrome's user agent. Google turns away sign-ins from browsers it can
 * tell are embedded, and Slack's and Jira's SSO both go through it.
 */
const USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

const close = () => useInAppBrowser.setState({ url: null });

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

	useEffect(() => {
		const webview = view.current;
		if (!url || !webview) return;
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
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") close();
		};
		webview.addEventListener("did-navigate", onNavigate);
		webview.addEventListener("did-navigate-in-page", onNavigate);
		webview.addEventListener("page-title-updated", onTitle);
		window.addEventListener("keydown", onKey);
		return () => {
			webview.removeEventListener("did-navigate", onNavigate);
			webview.removeEventListener("did-navigate-in-page", onNavigate);
			webview.removeEventListener("page-title-updated", onTitle);
			window.removeEventListener("keydown", onKey);
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
					<button
						type="button"
						title="Open in your browser"
						onClick={() => {
							openExternal.mutate(page.url || url);
							close();
						}}
						className={cn(
							"flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium",
							BUTTON.secondary,
						)}
					>
						<HiArrowTopRightOnSquare className="size-3.5" />
						Open in browser
					</button>
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
