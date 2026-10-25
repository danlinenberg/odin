import { clipboard, Menu } from "electron";
import { safeOpenExternal } from "main/lib/safe-url";

const isWebUrl = (url: string) =>
	url.startsWith("http://") || url.startsWith("https://");

/**
 * The right-click menu in Odin's in-app browser (Slack, Jira, GitHub, Notion
 * webviews). Electron shows none by default, so right-click did nothing:
 * links get Open in Browser and Copy Link, text gets Copy, fields get the
 * edit menu, and the page itself gets Back, Forward, Reload and its URL.
 */
export function attachInAppBrowserContextMenu(wc: Electron.WebContents): void {
	wc.on("context-menu", (_event, params) => {
		const { linkURL, pageURL, selectionText, editFlags, isEditable } = params;
		const items: Electron.MenuItemConstructorOptions[] = [];

		if (linkURL && isWebUrl(linkURL)) {
			items.push(
				{
					label: "Open Link in Browser",
					click: () => void safeOpenExternal(linkURL),
				},
				{
					label: "Open Link Here",
					click: () => void wc.loadURL(linkURL).catch(() => {}),
				},
				{
					label: "Copy Link",
					click: () => clipboard.writeText(linkURL),
				},
				{ type: "separator" },
			);
		}

		if (isEditable) {
			items.push(
				{ role: "undo", enabled: editFlags.canUndo },
				{ role: "redo", enabled: editFlags.canRedo },
				{ type: "separator" },
				{ role: "cut", enabled: editFlags.canCut },
				{ role: "copy", enabled: editFlags.canCopy },
				{ role: "paste", enabled: editFlags.canPaste },
				{ role: "selectAll", enabled: editFlags.canSelectAll },
				{ type: "separator" },
			);
		} else if (selectionText) {
			items.push({ role: "copy" }, { type: "separator" });
		}

		const page = isWebUrl(pageURL) ? pageURL : "";
		items.push(
			{
				label: "Back",
				enabled: wc.navigationHistory.canGoBack(),
				click: () => wc.navigationHistory.goBack(),
			},
			{
				label: "Forward",
				enabled: wc.navigationHistory.canGoForward(),
				click: () => wc.navigationHistory.goForward(),
			},
			{ label: "Reload", click: () => wc.reload() },
			{ type: "separator" },
			{
				label: "Open Page in Browser",
				enabled: !!page,
				click: () => void safeOpenExternal(page),
			},
			{
				label: "Copy Page Link",
				enabled: !!page,
				click: () => clipboard.writeText(page),
			},
		);

		Menu.buildFromTemplate(items).popup();
	});
}
