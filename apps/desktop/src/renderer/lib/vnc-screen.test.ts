import { describe, expect, it } from "bun:test";
import type RFB from "@novnc/novnc";
import { tuneForLink } from "./vnc-screen";

function setup(platform: string, clipboardText = "from this computer") {
	const written: string[] = [];
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {
			platform,
			clipboard: {
				readText: async () => clipboardText,
				writeText: async (text: string) => void written.push(text),
			},
		},
	});
	const sent: string[] = [];
	const rfb = Object.assign(new EventTarget(), {
		sendKey: (keysym: number, _code: string, down?: boolean) =>
			sent.push(
				`${keysym.toString(16)}${down === undefined ? "" : down ? "+" : "-"}`,
			),
		clipboardPasteFrom: (text: string) => sent.push(`paste:${text}`),
	});
	const screen = new EventTarget() as unknown as HTMLElement;
	const untune = tuneForLink(rfb as unknown as RFB, screen);
	const press = (key: string, mods: Partial<KeyboardEvent>) => {
		const event = new Event("keydown", { cancelable: true });
		Object.assign(event, { key, code: `Key${key.toUpperCase()}`, ...mods });
		screen.dispatchEvent(event);
		return event.defaultPrevented;
	};
	return { rfb, sent, written, press, untune };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("tuneForLink", () => {
	it("on a Mac, Cmd+V puts the clipboard on the host, then presses Ctrl+V there", async () => {
		const { sent, press } = setup("MacIntel");
		expect(press("v", { metaKey: true })).toBe(true);
		await tick();
		expect(sent).toEqual([
			"paste:from this computer",
			"ffe9-",
			"ffeb-",
			"ffe3+",
			"76",
			"ffe3-",
		]);
	});

	it("on a Mac, Cmd+C presses Ctrl+C on the host; plain keys pass through", () => {
		const { sent, press } = setup("MacIntel");
		press("c", { metaKey: true });
		expect(sent).toEqual(["ffe9-", "ffeb-", "ffe3+", "63", "ffe3-"]);
		expect(press("c", {})).toBe(false);
	});

	it("off a Mac, only Ctrl+V is caught, and Ctrl is already held on the host", async () => {
		const { sent, press } = setup("Win32");
		expect(press("c", { ctrlKey: true })).toBe(false);
		press("v", { ctrlKey: true });
		await tick();
		expect(sent).toEqual(["paste:from this computer", "76"]);
	});

	it("what the app copies lands on this computer's clipboard, until undone", () => {
		const { rfb, written, untune } = setup("MacIntel");
		const copied = () =>
			rfb.dispatchEvent(
				new CustomEvent("clipboard", { detail: { text: "from the app" } }),
			);
		copied();
		untune();
		copied();
		expect(written).toEqual(["from the app"]);
	});
});
