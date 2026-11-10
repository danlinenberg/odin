import RFB from "@novnc/novnc";

/**
 * The View on my computer window: noVNC on the VNC server a remote session
 * shares (view-on-mac), through the local end of its ssh tunnel. noVNC asks
 * for tight encoding with JPEG, far less data over the host link than macOS
 * Screen Sharing's lossless zlib. The window takes the server's name (the
 * session's title).
 */
const query = new URLSearchParams(location.search);
const status = document.getElementById("status") as HTMLElement;
const rfb = new RFB(
	document.getElementById("screen") as HTMLElement,
	`ws://127.0.0.1:${query.get("port")}/`,
	{ credentials: { password: query.get("password") ?? "" } },
);
rfb.scaleViewport = true;
rfb.addEventListener("connect", () => {
	status.textContent = "";
});
rfb.addEventListener("desktopname", (event) => {
	document.title = event.detail.name;
});
rfb.addEventListener("disconnect", (event) => {
	status.textContent = event.detail.clean
		? "The app's screen closed."
		: "Lost the connection to the host. Click View on my computer again.";
});
