import RFB from "@novnc/novnc";
import { tuneForLink } from "renderer/lib/vnc-screen";

/**
 * The View tab's own window (Open in window in the drawer's View tab): noVNC
 * on the VNC server a remote session shares (view-on-mac), through the local
 * end of its ssh tunnel. The window resizes freely and the screen scales to
 * it. The window takes the server's name (the session's title).
 */
const query = new URLSearchParams(location.search);
const status = document.getElementById("status") as HTMLElement;
const screen = document.getElementById("screen") as HTMLElement;
const rfb = new RFB(screen, `ws://127.0.0.1:${query.get("port")}/`, {
	credentials: { password: query.get("password") ?? "" },
});
tuneForLink(rfb, screen);
rfb.addEventListener("connect", () => {
	status.textContent = "";
});
rfb.addEventListener("desktopname", (event) => {
	document.title = event.detail.name;
});
rfb.addEventListener("disconnect", (event) => {
	status.textContent = event.detail.clean
		? "The app's screen closed."
		: "Lost the connection to the host. Close this window and open ▣ View again.";
});
