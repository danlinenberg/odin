import type RFB from "@novnc/novnc";

const XK_Control_L = 0xffe3;
const XK_Alt_L = 0xffe9;
const XK_Super_L = 0xffeb;

/**
 * A host's screen as the View tab and its window show it: scaled to fit,
 * JPEG at quality 4 (4:2:0, about 60) instead of noVNC's 6. Measured on a
 * scrolling Electron app through x11vnc, that sends 37% fewer bytes per
 * frame, and the link to the host, not the decoding, sets the frame rate.
 * x11vnc keeps flat UI areas such as text lossless either way.
 * Returns what undoes the clipboard hooks.
 */
export function tuneForLink(rfb: RFB, screen: HTMLElement): () => void {
	rfb.scaleViewport = true;
	rfb.qualityLevel = 4;
	return shareClipboard(rfb, screen);
}

/**
 * Copy and paste between this computer and the app on the host's screen
 * (the View tab and its window). What the app copies lands on this
 * computer's clipboard. Paste (Cmd+V on a Mac, Ctrl+V elsewhere) first puts
 * this computer's clipboard on the host, then presses Ctrl+V there. On a Mac,
 * Cmd+C, Cmd+X, Cmd+A and Cmd+Z press Ctrl in the app too, since the host
 * runs Linux. Plain text only, as VNC carries it (Latin-1).
 */
function shareClipboard(rfb: RFB, screen: HTMLElement): () => void {
	const copied = (event: CustomEvent<{ text: string }>) =>
		void navigator.clipboard.writeText(event.detail.text).catch(() => {});
	rfb.addEventListener("clipboard", copied);

	const isMac = navigator.platform.toUpperCase().startsWith("MAC");
	const onKeyDown = (event: KeyboardEvent) => {
		const key = event.key.toLowerCase();
		const cmd = isMac
			? event.metaKey && !event.ctrlKey
			: event.ctrlKey && !event.metaKey;
		if (!cmd || event.altKey || key.length !== 1 || !"cvxaz".includes(key))
			return;
		if (!isMac && key !== "v") return; // Ctrl+C etc. already reach the app.
		event.preventDefault();
		event.stopPropagation();
		const keysym = key.charCodeAt(0) + (event.shiftKey ? -32 : 0);
		const press = () => {
			if (!isMac) return rfb.sendKey(keysym, event.code);
			// noVNC holds left Cmd as Alt and right Cmd as Super on the host.
			rfb.sendKey(XK_Alt_L, "MetaLeft", false);
			rfb.sendKey(XK_Super_L, "MetaRight", false);
			rfb.sendKey(XK_Control_L, "ControlLeft", true);
			rfb.sendKey(keysym, event.code);
			rfb.sendKey(XK_Control_L, "ControlLeft", false);
		};
		if (key !== "v") return press();
		navigator.clipboard
			.readText()
			.then((text) => text && rfb.clipboardPasteFrom(text))
			.catch(() => {})
			.finally(press);
	};
	// Capture: before noVNC's own key handler on its canvas.
	screen.addEventListener("keydown", onKeyDown, true);
	return () => {
		screen.removeEventListener("keydown", onKeyDown, true);
		rfb.removeEventListener("clipboard", copied);
	};
}
