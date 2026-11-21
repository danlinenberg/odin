import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ODIN_HOME_DIR } from "./app-environment";
import { getNotificationsPort } from "./notifications/listen";

/**
 * The Odin extension for Chrome: on any page, the sessions that worked on what
 * it shows (a design file, an email campaign, a doc), with a count on its
 * toolbar icon and a list that opens each one in Odin's Session History. It
 * asks this Odin's /sessions/for-url, which matches the page URL's ids against
 * what each session's MCP calls and links named.
 *
 * Written as a folder Chrome loads with Load unpacked, at a path that stays the
 * same across Odin updates, so Chrome keeps loading it. The port is written in
 * each time, so Get the extension again after Odin moves port.
 */
export const CHROME_EXTENSION_DIR = join(ODIN_HOME_DIR, "chrome-extension");

export function chromeExtensionFiles(port: number): Record<string, string> {
	const manifest = {
		manifest_version: 3,
		name: "Odin",
		version: "1.0.0",
		description:
			"Shows the Odin sessions that worked on the page you have open.",
		permissions: ["tabs", "storage"],
		host_permissions: ["http://127.0.0.1/*"],
		background: { service_worker: "background.js" },
		action: { default_popup: "popup.html", default_title: "Odin sessions" },
	};
	const shared = `const DEFAULT_PORT = ${port};
async function sessionsFor(url) {
	if (!/^https?:\\/\\//.test(url || "")) return [];
	const { port } = await chrome.storage.local.get({ port: DEFAULT_PORT });
	const res = await fetch(
		"http://127.0.0.1:" + port + "/sessions/for-url?url=" + encodeURIComponent(url),
	);
	if (!res.ok) throw new Error("Odin answered " + res.status);
	return (await res.json()).sessions;
}
`;
	const background = `${shared}
async function badge(tabId, url) {
	try {
		const sessions = await sessionsFor(url);
		await chrome.action.setBadgeText({ tabId, text: sessions.length ? String(sessions.length) : "" });
	} catch {
		await chrome.action.setBadgeText({ tabId, text: "" });
	}
}
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
	if (change.url || change.status === "complete") badge(tabId, tab.url);
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
	const tab = await chrome.tabs.get(tabId);
	badge(tabId, tab.url);
});
chrome.action.setBadgeBackgroundColor({ color: "#6d5dfc" });
`;
	const popupHtml = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body { font: 13px system-ui, sans-serif; width: 320px; margin: 0; padding: 12px; color: #1a1a1a; }
h1 { font-size: 13px; margin: 0 0 8px; }
a { display: block; padding: 6px 8px; border-radius: 6px; color: inherit; text-decoration: none; }
a:hover { background: #f0eefe; }
.when { color: #777; font-size: 11px; }
.empty { color: #777; }
input { width: 70px; }
</style></head><body>
<h1>Odin sessions on this page</h1>
<div id="list" class="empty">Looking...</div>
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
async function show() {
	const list = document.getElementById("list");
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	try {
		const sessions = await sessionsFor(tab && tab.url);
		list.textContent = sessions.length ? "" : "No session worked on this page.";
		for (const session of sessions) {
			const link = document.createElement("a");
			link.href = "#";
			link.textContent = session.title;
			const when = document.createElement("div");
			when.className = "when";
			when.textContent = ago(session.updatedAt);
			link.append(when);
			// Odin's own link: Chrome hands it to Odin and keeps this page.
			link.onclick = () => chrome.tabs.update(tab.id, { url: session.open });
			list.append(link);
		}
	} catch {
		const { port } = await chrome.storage.local.get({ port: DEFAULT_PORT });
		list.textContent = "Odin isn't answering on port " + port + ". Is it open?";
		document.getElementById("port").value = port;
		document.getElementById("port-row").hidden = false;
	}
}
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
