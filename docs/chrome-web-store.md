# The Chrome extension in the Chrome Web Store

Everything the Chrome Web Store developer dashboard asks for, ready to paste.
The extension is written by `apps/desktop/src/main/lib/chrome-extension.ts`;
the store package comes from:

```sh
cd apps/desktop && bun run chrome-extension:zip   # -> dist/odin-chrome-extension.zip
```

Upload that zip as a new item. Each later release: raise `version` in the
manifest, rebuild, and upload it to the same item.

## Store listing

| Field | Value |
|---|---|
| Name | Odin (from the manifest) |
| Summary | Shows the Odin sessions that worked on the page you have open. |
| Category | Developer Tools |
| Language | English |
| Icon | `icon128.png` in the package (Odin's icon) |

Description:

> Odin runs your Claude Code sessions. This extension shows, on any page, which
> of them worked on what the page shows: a design file and the frame in it, an
> email campaign, a doc, a chat thread, an issue, a pull request.
>
> The toolbar icon counts those sessions. Click it to list them, with each
> session's title and when it last ran, and pick one to open it in Odin's
> Session History. While a session is still working on the page, a small green
> banner in its corner says so (turn it on from the popup); click it to open
> that session.
>
> It needs the Odin desktop app running on the same computer. It talks only to
> Odin on 127.0.0.1 and sends nothing anywhere else.

Screenshots (1280x800): the popup listing two sessions over a design file,
and the toolbar badge. Take them in Chrome with the extension loaded.

## Privacy practices

| Field | Value |
|---|---|
| Single purpose | Show which of your Odin sessions worked on the page you have open. |
| `tabs` | Reads the open tab's URL so the badge can count that page's sessions as you switch tabs and pages. |
| `storage` | Keeps the port of your Odin app when it isn't the default one. |
| `scripting` | Draws a small banner in the corner of a page while one of your Odin sessions is working on it, only after you turn the banner on in the popup. Nothing is injected into any other page. |
| Host permission `http://127.0.0.1/*` | Asks the Odin app on your own computer which sessions match the page. Nothing else is contacted. |
| Optional host permission `<all_urls>` | Requested only when you click "Show a banner on pages a session is working on" in the popup, so the banner can be drawn on whichever site a session is working on. It reads nothing from the page and contacts nothing else. |
| Remote code | No. Every script is in the package. |
| Data collected | Web history (the open tab's URL), sent only to the Odin app on the same computer, never off it. |
| Certifications | Not sold, not used for anything but the single purpose, not used for creditworthiness. |
| Privacy policy URL | This file's "Privacy policy" section on GitHub. |

## Privacy policy

The Odin extension for Chrome reads the address of the tab you have open and
sends it to the Odin desktop app on your own computer (`127.0.0.1`), which
answers with the titles of your sessions that worked on that page. Neither the
address nor the answer leaves your computer: the extension makes no other
network request, has no account, no analytics and no third party. It stores one
setting, the Odin app's port, in Chrome's extension storage. Removing the
extension removes that setting.

## Review notes

The extension only works with the Odin desktop app running. Without it, the
popup says "Odin isn't answering on port 51741. Is it open?", which is the
expected result for a reviewer without Odin.
