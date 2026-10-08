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
	HiArrowDownTray,
	HiArrowLeft,
	HiArrowPath,
	HiArrowRight,
	HiArrowTopRightOnSquare,
	HiChevronDown,
	HiChevronUp,
	HiKey,
	HiXMark,
} from "react-icons/hi2";
import { useZoomFactor } from "renderer/hooks/useZoomFactor";
import { getDispatchChord, matchesChord } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	type SlackThread,
	slackThread,
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

const copyLink = (webview: WebviewTag, copyText: (text: string) => void) => {
	copyText(webview.getURL());
	toast("Link copied");
};

/**
 * Fills the page's sign-in form. Values go in through the native setter and
 * an input event, so a framework-controlled field (React) keeps them.
 */
const fillLoginScript = ({
	username,
	password,
}: {
	username: string;
	password: string;
}) => `(() => {
	const password = document.querySelector("input[type=password]");
	if (!password) return false;
	const set = (el, value) => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	};
	const user = [...document.querySelectorAll("input")].filter((el) =>
		["", "text", "email"].includes(el.type) && el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
	).at(-1);
	if (user) set(user, ${JSON.stringify(username)});
	set(password, ${JSON.stringify(password)});
	return true;
})()`;

/** What a page in the panel logs when Esc goes unhandled there. */
const ESCAPE_SIGNAL = "odin:in-app-browser:escape";
/** What it logs, followed by the key as JSON, for a key pressed with ⌘, Ctrl or ⌥. */
const KEY_SIGNAL = "odin:in-app-browser:key:";

/** The Copy Link shortcut (⌘L unless Settings → Keyboard says otherwise). */
const isCopyLink = (event: KeyboardEvent) => {
	const chord = getDispatchChord("ODIN_COPY_LINK");
	return !!chord && matchesChord(event, chord);
};

/** Search (⌘F unless Settings → Keyboard says otherwise) finds in the page. */
const isFind = (event: KeyboardEvent) => {
	const chord = getDispatchChord("ODIN_BOARD_SEARCH");
	return !!chord && matchesChord(event, chord);
};

/**
 * A page in the panel is its own document, so its keys never reach Odin's
 * window. It reports an Esc it didn't use itself (a Jira modal closing takes
 * it) through its console instead. Slack's web client prevents every Esc,
 * open menu or not, so an Esc the page took still counts when nothing was
 * open for it to close. Checked in the capture phase, before the page's own
 * handlers close whatever was open. A Slack preview that opened without
 * taking focus (focus stays on <body>) never sees the Esc, so it gets the Esc
 * passed on and closes, instead of the panel closing under it. It reports
 * every modifier chord too, and Odin matches it against the Copy Link and
 * Search shortcuts, so a rebind applies to a page that's already open.
 */
// ponytail: only react-modal (Slack's previews) gets the Esc passed on; add
// another site's modal class when one turns up with the same focus gap.
const REPORT_KEYS = `addEventListener("keydown", (event) => {
	if (event.metaKey || event.ctrlKey || event.altKey) {
		const { code, metaKey, ctrlKey, altKey, shiftKey } = event;
		console.debug(${JSON.stringify(KEY_SIGNAL)} + JSON.stringify({ code, metaKey, ctrlKey, altKey, shiftKey }));
	}
	if (event.key !== "Escape") return;
	const open = [...document.querySelectorAll("[role=dialog],[role=menu],[role=listbox],[aria-modal=true]")]
		.filter((el) => el.getClientRects().length > 0);
	setTimeout(() => {
		if (event.defaultPrevented && open.length) return;
		const modal = open.findLast((el) => el.matches(".ReactModal__Content"));
		if (modal && !modal.contains(event.target)) {
			modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
			return;
		}
		console.debug(${JSON.stringify(ESCAPE_SIGNAL)});
	});
}, true);`;

/**
 * Runs in Slack's web client: opens a thread the way Slack's own Back button
 * does, in the client that's already running, instead of booting it again
 * (~2s, a dozen API round trips before the thread's own). Slack renders the
 * view a popstate's state names, as long as its id is an entry Slack made, so
 * the current entry is rewritten to name the thread. True once the thread is
 * on screen; false when this isn't that workspace's client, or Slack didn't
 * take it, and the link should load instead.
 */
async function openSlackThread({
	workspace,
	channel,
	threadTs,
	replyTs,
}: SlackThread): Promise<boolean> {
	const current = history.state;
	if (!current?.isIA4 || !current.state?.home) return false;
	const config = JSON.parse(localStorage.getItem("localConfig_v2") ?? "{}");
	if (config.teams?.[current.teamId]?.domain !== workspace) return false;
	const threadId = `${channel}-${threadTs}`;
	const next = structuredClone(current);
	next.activeTab = "home";
	next.state.home.primary = {
		id: channel,
		viewType: "Channel",
		params: {
			teamOrEnterpriseId: current.teamId,
			entityId: channel,
			threadId,
			replyTs,
			parentTab: channel,
			tabId: "channel",
		},
		uiState: { [channel]: {} },
	};
	next.state.home.secondary = {
		id: "thread",
		viewType: "Thread",
		params: { threadId, replyTs, parentTab: channel },
	};
	// The channel's own URL, as Slack writes it, so Copy Link and Open in
	// browser name this channel rather than the one before.
	history.replaceState(next, "", `/client/${current.teamId}/${channel}`);
	dispatchEvent(new PopStateEvent("popstate", { state: next }));
	// A long thread opens scrolled to the reply, its first message unrendered.
	// A slow one is still worth the wait: giving up starts the load over.
	const shown = `[data-msg-ts="${threadTs}"], [data-msg-ts="${replyTs}"]`;
	for (let i = 0; i < 160; i++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		const pane = document.querySelector('[data-qa="threads_flexpane"]');
		if (pane?.querySelector(shown)) {
			// The cursor goes to the reply box, as Slack's own thread click does.
			pane
				.querySelector<HTMLElement>('.ql-editor[contenteditable="true"]')
				?.focus();
			return true;
		}
	}
	return false;
}

/** Takes a page that's already open to a new link. */
async function show(webview: WebviewTag, url: string) {
	try {
		const thread = slackThread(url);
		if (
			thread &&
			(await webview.executeJavaScript(
				`(${openSlackThread})(${JSON.stringify(thread)})`,
			))
		) {
			return;
		}
		// Another link took over while Slack had a go at this one.
		if (useInAppBrowser.getState().url !== url) return;
		webview.loadURL(url).catch(() => {});
	} catch {
		// Its first page isn't far enough along to take a script or a load.
		webview.src = url;
	}
}

/**
 * Slack keeps a page of its own, so its client stays booted while a Jira
 * ticket or a PR opens in between.
 */
type Site = "slack" | "web";
const SITES: Site[] = ["slack", "web"];
const siteOf = (url: string): Site =>
	/^https:\/\/([\w-]+\.)*slack\.com\//i.test(url) ? "slack" : "web";

/** Narrow enough to keep a board column in view, wide enough for Jira's sidebar. */
const MIN_WIDTH = 480;

/**
 * Drag the panel's left edge. Its width is kept as a share of the area it
 * opens over, like the session drawer's, so it still fits a smaller window.
 */
const startResize = (
	event: React.PointerEvent<HTMLDivElement>,
	setResizing: (resizing: boolean) => void,
) => {
	event.preventDefault();
	const area = event.currentTarget.parentElement?.parentElement;
	if (!area) return;
	setResizing(true);
	const onMove = (move: PointerEvent) => {
		const { right, width } = area.getBoundingClientRect();
		useInAppBrowser.setState({
			widthFraction: Math.min(Math.max((right - move.clientX) / width, 0), 1),
		});
	};
	const onUp = () => {
		setResizing(false);
		window.removeEventListener("pointermove", onMove);
		window.removeEventListener("pointerup", onUp);
	};
	window.addEventListener("pointermove", onMove);
	window.addEventListener("pointerup", onUp);
};

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
	const widthFraction = useInAppBrowser((state) => state.widthFraction);
	const [resizing, setResizing] = useState(false);
	const openExternal = electronTrpc.external.openUrl.useMutation();
	const { mutate: copyText } = electronTrpc.external.copyText.useMutation();
	const onePassword = electronTrpc.browser.onePasswordLogin.useMutation();
	const importCookies = electronTrpc.browser.importCookies.useMutation();
	// Each site's first link. Its page stays loaded while the panel is
	// closed, so the next link doesn't start the site over.
	const [sites, setSites] = useState<Partial<Record<Site, string>>>({});
	const views = useRef<Partial<Record<Site, WebviewTag>>>({});
	// Webviews already handed the cursor once. The ref below is inline, so React
	// calls it with null and then the same element on every render - keyed on
	// `views` alone, each re-render looked like a new site and took the keyboard
	// back from whatever you were typing in (the chat box, beside the panel).
	const focusedViews = useRef(new WeakSet<Element>());
	const [pages, setPages] = useState<
		Partial<Record<Site, { title: string; url: string }>>
	>({});
	const zoomFactor = useZoomFactor();
	const site = url ? siteOf(url) : null;
	const page = (site && pages[site]) || { title: "", url: "" };
	// The find bar's text; null while it's hidden.
	const [find, setFind] = useState<string | null>(null);
	const [matches, setMatches] = useState({ active: 0, total: 0 });
	const findInput = useRef<HTMLInputElement>(null);
	const openFind = () => {
		setFind((prev) => prev ?? "");
		// It may not be rendered yet.
		requestAnimationFrame(() => findInput.current?.select());
	};
	const closeFind = (refocus: boolean) => {
		setFind(null);
		setMatches({ active: 0, total: 0 });
		const webview = site ? views.current[site] : undefined;
		try {
			webview?.stopFindInPage("clearSelection");
		} catch {
			// Not attached.
		}
		if (refocus) webview?.focus();
	};
	const findNext = (forward: boolean) => {
		const webview = site ? views.current[site] : undefined;
		if (webview && find) webview.findInPage(find, { forward, findNext: false });
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: sites re-reads views when a site's page mounts
	useEffect(() => {
		const detach = Object.entries(views.current).map(([key, webview]) => {
			const site = key as Site;
			// A <webview> keeps its own zoom: it starts at 100% whatever Odin's
			// zoom is, and Chromium resets it per site. So it takes Odin's on
			// every navigation, and again whenever Odin's changes.
			const applyZoom = () => webview.setZoomFactor(zoomFactor);
			try {
				applyZoom();
			} catch {
				// Not attached yet; its first did-navigate applies it.
			}
			const setPage = (patch: { title?: string; url?: string }) =>
				setPages((prev) => ({
					...prev,
					[site]: { title: "", url: "", ...prev[site], ...patch },
				}));
			const onNavigate = (event: Event) => {
				const { url } = event as { url?: string };
				if (url) setPage({ url });
			};
			const onTitle = (event: Event) =>
				setPage({ title: (event as { title?: string }).title ?? "" });
			const onReady = () => {
				webview.executeJavaScript(REPORT_KEYS).catch(() => {});
			};
			const onConsole = (event: Event) => {
				const message = (event as { message?: string }).message;
				if (message === ESCAPE_SIGNAL) close();
				if (
					message?.startsWith(KEY_SIGNAL) &&
					isCopyLink(
						new KeyboardEvent(
							"keydown",
							JSON.parse(message.slice(KEY_SIGNAL.length)),
						),
					)
				) {
					copyLink(webview, copyText);
				}
				if (
					message?.startsWith(KEY_SIGNAL) &&
					isFind(
						new KeyboardEvent(
							"keydown",
							JSON.parse(message.slice(KEY_SIGNAL.length)),
						),
					)
				) {
					openFind();
				}
			};
			const onFound = (event: Event) => {
				const { result } = event as unknown as {
					result: { activeMatchOrdinal: number; matches: number };
				};
				setMatches({
					active: result.activeMatchOrdinal,
					total: result.matches,
				});
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
			webview.addEventListener("did-navigate", applyZoom);
			webview.addEventListener("did-navigate", onNavigate);
			webview.addEventListener("did-navigate-in-page", onNavigate);
			webview.addEventListener("page-title-updated", onTitle);
			webview.addEventListener("dom-ready", onReady);
			webview.addEventListener("console-message", onConsole);
			webview.addEventListener("found-in-page", onFound);
			webview.addEventListener("did-start-navigation", toSlackWebClient);
			webview.addEventListener("did-redirect-navigation", toSlackWebClient);
			return () => {
				webview.removeEventListener("did-navigate", applyZoom);
				webview.removeEventListener("did-navigate", onNavigate);
				webview.removeEventListener("did-navigate-in-page", onNavigate);
				webview.removeEventListener("page-title-updated", onTitle);
				webview.removeEventListener("dom-ready", onReady);
				webview.removeEventListener("console-message", onConsole);
				webview.removeEventListener("found-in-page", onFound);
				webview.removeEventListener("did-start-navigation", toSlackWebClient);
				webview.removeEventListener(
					"did-redirect-navigation",
					toSlackWebClient,
				);
			};
		});
		return () => {
			for (const listener of detach) listener();
		};
	}, [sites, zoomFactor, copyText]);

	// A new link, or the panel closing, ends the find.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on url only
	useEffect(() => () => closeFind(false), [url]);

	useEffect(() => {
		if (!url) return;
		const site = siteOf(url);
		const webview = views.current[site];
		if (webview) {
			setPages((prev) => ({ ...prev, [site]: { title: "", url } }));
			void show(webview, url);
		} else {
			// Its <webview>'s src loads it.
			setSites((prev) => ({ ...prev, [site]: url }));
		}
	}, [url]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: openFind only sets state and a ref
	useEffect(() => {
		if (!url) return;
		const site = siteOf(url);
		// Whatever had focus when the link opened - the session's terminal,
		// Catch up - gets it back on close, instead of it falling to <body>.
		const opener = document.activeElement;
		// Typing goes to the link, not the terminal under the panel. A site's
		// first link has no page yet; its <webview> takes focus as it mounts.
		views.current[site]?.focus();
		// Captured and stopped at the window: Esc closes the panel and nothing
		// under it - not the session drawer, not Catch up, not the terminal.
		const onKey = (event: KeyboardEvent) => {
			// The toolbar, or whatever kept focus under the panel.
			if (isCopyLink(event)) {
				event.preventDefault();
				event.stopImmediatePropagation();
				const webview = views.current[site];
				if (webview) copyLink(webview, copyText);
				return;
			}
			if (isFind(event)) {
				event.preventDefault();
				event.stopImmediatePropagation();
				openFind();
				return;
			}
			if (event.key !== "Escape") return;
			// The "Open in browser" menu and the find bar close themselves first.
			if (
				(event.target as HTMLElement | null)?.closest("[role=menu],[data-find]")
			)
				return;
			event.preventDefault();
			event.stopImmediatePropagation();
			close();
		};
		window.addEventListener("keydown", onKey, { capture: true });
		return () => {
			window.removeEventListener("keydown", onKey, { capture: true });
			if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
		};
	}, [url, copyText]);

	if (!url && !sites.slack && !sites.web) return null;
	const view = () => (site ? views.current[site] : undefined);

	return (
		<>
			{url && (
				<button
					type="button"
					aria-label="Close browser"
					className="absolute inset-0 z-[60] cursor-default bg-black/35"
					onClick={close}
				/>
			)}
			<div
				className={cn(
					"absolute inset-y-0 right-0 z-[60] flex max-w-full flex-col border-l border-border bg-background shadow-2xl",
					widthFraction === null && "w-[min(1200px,92%)]",
					// Closed, it stays loaded, out of sight.
					!url && "invisible",
				)}
				style={
					widthFraction === null
						? undefined
						: { width: `max(${MIN_WIDTH}px, ${widthFraction * 100}%)` }
				}
			>
				<div
					onPointerDown={(event) => startResize(event, setResizing)}
					className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
				/>
				<div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
					<button
						type="button"
						title="Back"
						className={ICON_BUTTON}
						onClick={() => view()?.goBack()}
					>
						<HiArrowLeft className="size-4" />
					</button>
					<button
						type="button"
						title="Forward"
						className={ICON_BUTTON}
						onClick={() => view()?.goForward()}
					>
						<HiArrowRight className="size-4" />
					</button>
					<button
						type="button"
						title="Reload"
						className={ICON_BUTTON}
						onClick={() => view()?.reload()}
					>
						<HiArrowPath className="size-4" />
					</button>
					<button
						type="button"
						title="Fill login from 1Password"
						className={ICON_BUTTON}
						onClick={() => {
							const webview = view();
							if (!webview) return;
							onePassword.mutate(
								{ url: webview.getURL() },
								{
									onSuccess: async (login) => {
										if (!login) {
											toast("No 1Password login for this site");
											return;
										}
										const filled = await webview.executeJavaScript(
											fillLoginScript(login),
										);
										if (!filled) toast("No password field on this page");
									},
									onError: (error) => toast(error.message),
								},
							);
						}}
					>
						<HiKey className="size-4" />
					</button>
					<span
						title={page.url}
						className="min-w-0 flex-1 truncate px-2 text-[13px] text-muted-foreground"
					>
						{url && (page.title || new URL(page.url || url).host)}
					</span>
					{find !== null && (
						<div
							data-find
							className="flex items-center gap-0.5 rounded-md border border-border px-1.5"
						>
							<input
								ref={findInput}
								value={find}
								placeholder="Find in page"
								className="w-40 bg-transparent py-1 text-xs outline-none"
								onChange={(event) => {
									const text = event.target.value;
									setFind(text);
									const webview = view();
									if (!webview) return;
									if (text) webview.findInPage(text, { findNext: true });
									else {
										webview.stopFindInPage("clearSelection");
										setMatches({ active: 0, total: 0 });
									}
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter") findNext(!event.shiftKey);
									if (event.key === "Escape") closeFind(true);
								}}
							/>
							<span className="min-w-10 text-right text-xs tabular-nums text-muted-foreground">
								{find && `${matches.active}/${matches.total}`}
							</span>
							<button
								type="button"
								title="Previous (⇧↩)"
								className={ICON_BUTTON}
								onClick={() => findNext(false)}
							>
								<HiChevronUp className="size-3.5" />
							</button>
							<button
								type="button"
								title="Next (↩)"
								className={ICON_BUTTON}
								onClick={() => findNext(true)}
							>
								<HiChevronDown className="size-3.5" />
							</button>
							<button
								type="button"
								title="Close find (Esc)"
								className={ICON_BUTTON}
								onClick={() => closeFind(true)}
							>
								<HiXMark className="size-3.5" />
							</button>
						</div>
					)}
					<div className="flex">
						<button
							type="button"
							title="Open in your browser"
							onClick={() => {
								if (url) openExternal.mutate(page.url || url);
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
										if (url) openExternal.mutate(page.url || url);
										close();
										alwaysExternal();
									}}
								>
									<HiArrowTopRightOnSquare className="size-3.5" />
									Always open links in your browser
								</DropdownMenuItem>
								<DropdownMenuItem
									onSelect={() =>
										importCookies.mutate(undefined, {
											onSuccess: ({ browser, profile, imported }) => {
												toast(`Signed in like ${browser}`, {
													description: `${imported} cookies from ${profile}.`,
												});
												view()?.reload();
											},
											onError: (error) => toast(error.message),
										})
									}
								>
									<HiArrowDownTray className="size-3.5" />
									Import sign-ins from your browser
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
				<div className="relative min-h-0 flex-1">
					{SITES.map(
						(key) =>
							sites[key] && (
								<webview
									key={key}
									ref={(element) => {
										if (!element) {
											delete views.current[key];
										} else {
											views.current[key] = element as WebviewTag;
											// A site's first link takes the cursor too - once.
											if (!focusedViews.current.has(element)) {
												focusedViews.current.add(element);
												element.focus();
											}
										}
									}}
									src={sites[key]}
									partition={IN_APP_BROWSER_PARTITION}
									// No passkeys: Electron can't show the Touch ID prompt, so a
									// site asking for one (Google does) waits forever. Without
									// WebAuthn it offers your phone or password instead.
									disableblinkfeatures="WebAuth"
									useragent={USER_AGENT}
									// Only read as present or absent; React drops a boolean
									// `true` on an attribute it doesn't know, so it has to be a
									// string.
									allowpopups={"true" as unknown as boolean}
									// A page under the pointer swallows its moves, which ends a
									// drag of the edge the moment it crosses into the page.
									className={cn(
										"absolute inset-0",
										key !== site && "invisible",
										resizing && "pointer-events-none",
									)}
								/>
							),
					)}
				</div>
			</div>
		</>
	);
}
