/**
 * Part of android-test.sh: reads the app's page over the web view's DevTools
 * socket (a debug build allows it) until the board shows a fake-odin sample
 * session, so the pair link, the Keystore plugin and the encrypted channel
 * all worked. Fails after 90s with what the page showed instead.
 */
import { $ } from "bun";

const EXPECT = "Fix HDR grouping test";
const PORT = 9333;
const deadline = Date.now() + 90_000;

async function devtoolsSocket(): Promise<string | null> {
	const sockets = await $`adb shell cat /proc/net/unix`.text();
	return sockets.match(/@(webview_devtools_remote_\d+)/)?.[1] ?? null;
}

async function pageText(): Promise<string> {
	const socket = await devtoolsSocket();
	if (!socket) return "(no web view yet)";
	await $`adb forward tcp:${PORT} localabstract:${socket}`.quiet();
	const targets = (await (
		await fetch(`http://127.0.0.1:${PORT}/json/list`)
	).json()) as { type: string; webSocketDebuggerUrl: string }[];
	const page = targets.find((t) => t.type === "page");
	if (!page) return "(no page yet)";
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	return await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("DevTools timeout")),
			10_000,
		);
		ws.onopen = () =>
			ws.send(
				JSON.stringify({
					id: 1,
					method: "Runtime.evaluate",
					params: {
						expression: "document.body.innerText",
						returnByValue: true,
					},
				}),
			);
		ws.onmessage = (event) => {
			const answer = JSON.parse(String(event.data));
			if (answer.id !== 1) return;
			clearTimeout(timer);
			ws.close();
			resolve(String(answer.result?.result?.value ?? ""));
		};
		ws.onerror = () => reject(new Error("DevTools socket error"));
	});
}

let last = "";
while (Date.now() < deadline) {
	try {
		last = await pageText();
		if (last.includes(EXPECT)) {
			console.log(`Paired: the board shows "${EXPECT}".`);
			process.exit(0);
		}
	} catch (failure) {
		last = String(failure);
	}
	await Bun.sleep(2_000);
}
console.error(`The board never showed "${EXPECT}". The page said:\n${last}`);
process.exit(1);
