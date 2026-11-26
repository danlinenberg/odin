import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ODIN_HOME_DIR } from "./app-environment";
import { getNotificationsPort } from "./notifications/listen";

/**
 * The Odin extension for Chrome: on any page, the sessions that worked on what
 * it shows (a design file, an email campaign, a doc), with a count on its
 * toolbar icon and a list that opens each one in Odin's Task History. It
 * asks this Odin's /sessions/for-url, which matches the page URL's ids against
 * what each session's MCP calls and links named.
 *
 * Written as a folder Chrome loads with Load unpacked, at a path that stays the
 * same across Odin updates, so Chrome keeps loading it. The port is written in
 * each time, so Get the extension again after Odin moves port.
 */
export const CHROME_EXTENSION_DIR = join(ODIN_HOME_DIR, "chrome-extension");

/** The store build's icon: Odin's own, rendered at 128px from the master. */
export const STORE_ICON = "icon128.png";

export function chromeExtensionFiles(
	port: number,
	{ store = false } = {},
): Record<string, string> {
	const manifest = {
		manifest_version: 3,
		name: "Odin",
		version: "1.0.5",
		description:
			"Shows the Odin sessions that worked on the page you have open.",
		permissions: ["tabs", "storage", "scripting"],
		host_permissions: ["http://127.0.0.1/*"],
		// Every site, only once you ask for the banner in the popup, so it can be
		// drawn on whichever page a session is working on. Pages without one get
		// nothing injected.
		optional_host_permissions: ["<all_urls>"],
		background: { service_worker: "background.js" },
		action: { default_popup: "popup.html", default_title: "Odin sessions" },
		...(store && { icons: { "128": STORE_ICON } }),
	};
	const shared = `const DEFAULT_PORT = ${port};
async function sessionsFor(url) {
	if (!/^https?:\\/\\//.test(url || "")) return [];
	const { port } = await chrome.storage.local.get({ port: DEFAULT_PORT });
	const res = await fetch(
		"http://127.0.0.1:" + port + "/sessions/for-url?url=" + encodeURIComponent(url),
	);
	if (!res.ok) throw new Error("Odin answered " + res.status);
	const { sessions } = await res.json();
	// Kept for the popup, so it opens on the last answer instead of searching again.
	await chrome.storage.session.set({ ["for " + url]: sessions });
	return sessions;
}
// What the last search for this page found, or undefined if none ran yet.
async function cachedSessionsFor(url) {
	const key = "for " + url;
	return (await chrome.storage.session.get(key))[key];
}
// The Odin that listed it opens it (a dev build has no odin:// link).
async function openSession(id, url) {
	const { port } = await chrome.storage.local.get({ port: DEFAULT_PORT });
	await fetch("http://127.0.0.1:" + port + "/sessions/open", {
		method: "POST",
		body: new URLSearchParams({ id, url }),
	});
}
// Written to in the last few minutes: the session is still working.
function isLive(session) {
	return Date.now() - session.updatedAt < 5 * 60000;
}
`;
	const background = `${shared}
async function badge(tabId, url) {
	try {
		const sessions = await sessionsFor(url);
		const live = sessions.filter(isLive).length;
		await chrome.action.setBadgeText({ tabId, text: sessions.length ? String(sessions.length) : "" });
		// Green while a session is working on this page, purple once they're all done.
		await chrome.action.setBadgeBackgroundColor({ tabId, color: live ? "#16a34a" : "#6d5dfc" });
		await chrome.action.setTitle({
			tabId,
			title: !sessions.length
				? "Odin sessions"
				: sessions.length + " Odin session" + (sessions.length > 1 ? "s" : "") +
					" on this page" + (live ? ", " + live + " working now" : ""),
		});
		await banner(tabId, url, live);
	} catch {
		await chrome.action.setBadgeText({ tabId, text: "" });
	}
}
// The tabs showing a banner now, and the pages whose banner was closed.
const bannered = new Set();
const dismissed = new Set();
async function banner(tabId, url, live) {
	const text = live && !dismissed.has(tabId + " " + url)
		? "Odin: " + live + " session" + (live > 1 ? "s" : "") + " working on this page"
		: "";
	if (!text && !bannered.has(tabId)) return;
	try {
		await chrome.scripting.executeScript({ target: { tabId }, func: drawBanner, args: [text] });
		if (text) bannered.add(tabId);
		else bannered.delete(tabId);
	} catch {
		// a page Chrome doesn't let extensions draw on (the Web Store, chrome://)
	}
}
// Runs in the page: a pill in the bottom-right corner, in a shadow root so the
// page's styles can't touch it. Empty text takes it down.
function drawBanner(text) {
	let host = document.getElementById("odin-session-banner");
	if (!text) return host && host.remove();
	if (!host) {
		host = document.createElement("div");
		host.id = "odin-session-banner";
		host.attachShadow({ mode: "open" }).innerHTML = \`<style>
div { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 2px;
	font: 600 12px system-ui, sans-serif; background: #16a34a; color: #fff; border-radius: 999px; box-shadow: 0 2px 8px #0003; }
button { all: unset; cursor: pointer; padding: 7px 12px; }
.x { padding: 7px 10px 7px 4px; opacity: .8; }
.x:hover { opacity: 1; }
</style><div><button class="open"></button><button class="x" title="Hide">\u00d7</button></div>\`;
		host.shadowRoot.querySelector(".open").onclick = () => chrome.runtime.sendMessage({ odin: "open" });
		host.shadowRoot.querySelector(".x").onclick = () => {
			host.remove();
			chrome.runtime.sendMessage({ odin: "dismiss" });
		};
		document.documentElement.append(host);
	}
	host.shadowRoot.querySelector(".open").textContent = "\u25cf " + text;
}
// The banner's buttons: open the session working on the page, or hide it here.
chrome.runtime.onMessage.addListener(async (message, sender) => {
	const tab = sender.tab;
	if (!tab) return;
	if (message.odin === "dismiss") {
		dismissed.add(tab.id + " " + tab.url);
		bannered.delete(tab.id);
	}
	if (message.odin === "open") {
		const [session] = (await sessionsFor(tab.url)).filter(isLive);
		if (session) await openSession(session.sessionId, tab.url);
	}
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
	if (change.url || change.status === "complete") badge(tabId, tab.url);
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
	const tab = await chrome.tabs.get(tabId);
	badge(tabId, tab.url);
});
`;
	const popupHtml = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body { font: 13px system-ui, sans-serif; width: 320px; margin: 0; padding: 12px; color: #1a1a1a; }
h1 { font-size: 13px; margin: 0 0 8px; }
a { display: flex; align-items: center; gap: 8px; padding: 8px 10px; margin-bottom: 6px; border: 1px solid #ddd; border-radius: 8px; color: inherit; text-decoration: none; cursor: pointer; }
a:hover { background: #f0eefe; border-color: #6d5dfc; }
a .text { flex: 1; min-width: 0; }
a .go { color: #6d5dfc; font-weight: 600; font-size: 12px; white-space: nowrap; }
.when { color: #777; font-size: 11px; }
.live { color: #16a34a; font-weight: 600; }
.empty { color: #777; }
input { width: 70px; }
</style></head><body>
<h1>Odin sessions on this page</h1>
<div id="list" class="empty">Looking...</div>
<p id="banner-row" hidden><button id="banner">Show a banner on pages a session is working on</button></p>
<p class="empty" id="port-row" hidden>Odin port <input id="port" type="number"> <button id="save">Save</button></p>
<script src="popup.js"></script>
</body></html>
`;
	const popup = `${shared}
function ago(ms) {
	const minutes = Math.round((Date.now() - ms) / 60000);
	if (minutes < 60) return minutes + "m ago";
	const hours = Math.round(minutes / 60);
	return hours < 48 ? hours + "h ago" : Math.round(hours / 24) + "d ago";
}
function render(list, tab, sessions) {
	list.textContent = sessions.length ? "" : "No session worked on this page.";
	for (const session of sessions) {
		const link = document.createElement("a");
		link.href = "#";
		link.title = "Open this session in Odin";
		const text = document.createElement("div");
		text.className = "text";
		text.textContent = session.title;
		const when = document.createElement("div");
		when.className = "when";
		when.textContent = isLive(session) ? "Working now" : ago(session.updatedAt);
		if (isLive(session)) when.className = "when live";
		text.append(when);
		const go = document.createElement("span");
		go.className = "go";
		go.textContent = "Open \u203a";
		link.append(text, go);
		link.onclick = async () => {
			await openSession(session.sessionId, tab.url);
			window.close();
		};
		list.append(link);
	}
}
async function show() {
	const list = document.getElementById("list");
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	// The badge already searched this page: show that now, then refresh it.
	const cached = tab && (await cachedSessionsFor(tab.url));
	if (cached) render(list, tab, cached);
	try {
		render(list, tab, await sessionsFor(tab && tab.url));
	} catch {
		if (cached) return;
		const { port } = await chrome.storage.local.get({ port: DEFAULT_PORT });
		list.textContent = "Odin isn't answering on port " + port + ". Is it open?";
		document.getElementById("port").value = port;
		document.getElementById("port-row").hidden = false;
	}
}
// Drawing on pages needs access to them, which Chrome asks for on this click.
const SITES = { origins: ["<all_urls>"] };
chrome.permissions.contains(SITES).then((granted) => {
	document.getElementById("banner-row").hidden = granted;
});
document.getElementById("banner").onclick = async () => {
	if (await chrome.permissions.request(SITES))
		document.getElementById("banner-row").hidden = true;
};
document.getElementById("save").onclick = async () => {
	await chrome.storage.local.set({ port: Number(document.getElementById("port").value) });
	show();
};
show();
`;
	return {
		"manifest.json": `${JSON.stringify(manifest, null, "\t")}\n`,
		"background.js": background,
		"popup.html": popupHtml,
		"popup.js": popup,
	};
}

/** Write the extension's folder (again) and return its path. */
export function writeChromeExtension(dir = CHROME_EXTENSION_DIR): string {
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(
		chromeExtensionFiles(getNotificationsPort()),
	))
		writeFileSync(join(dir, name), text);
	return dir;
}
