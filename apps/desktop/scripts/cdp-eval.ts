/**
 * Evaluate an expression file inside a running dev renderer (see AGENTS.md →
 * "Verifying renderer changes via CDP"). Prints the returned value; exits 1 if
 * the page throws.
 *
 *   RENDERER_REMOTE_DEBUG_PORT=19223 DESKTOP_VITE_PORT=5173 \
 *     bun run apps/desktop/scripts/cdp-eval.ts probe.js
 *
 * The expression runs in the page, so `import("/stores/tabs/store.ts")` reaches
 * the app's own modules — except ones edited this session, which HMR re-serves
 * with a `?t=` query, handing you a second instance. Assert on the DOM there.
 */
const PORT = process.env.RENDERER_REMOTE_DEBUG_PORT ?? "9333";
const VITE_PORT = process.env.DESKTOP_VITE_PORT ?? "3005";

interface CdpTarget {
	type: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

const expression = await Bun.file(process.argv[2] as string).text();

const targets = (await fetch(`http://127.0.0.1:${PORT}/json`).then((r) =>
	r.json(),
)) as CdpTarget[];
// Require a page target on THIS workspace's vite port (AGENTS.md).
const page = targets.find(
	(t) =>
		t.type === "page" &&
		t.webSocketDebuggerUrl &&
		t.url.includes(`localhost:${VITE_PORT}`),
);
if (!page?.webSocketDebuggerUrl) {
	console.error(
		`No renderer target on :${PORT} for vite port ${VITE_PORT}. Targets: ${targets
			.map((t) => `${t.type} ${t.url}`)
			.join(", ")}`,
	);
	process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const timer = setTimeout(() => {
	console.error("no result within 60s");
	process.exit(1);
}, 60_000);

ws.addEventListener("open", () => {
	console.error(`attached: ${page.url}`);
	ws.send(
		JSON.stringify({
			id: 1,
			method: "Runtime.evaluate",
			params: {
				expression,
				awaitPromise: true,
				returnByValue: true,
				userGesture: true,
			},
		}),
	);
});

ws.addEventListener("message", (event) => {
	const msg = JSON.parse(event.data as string);
	if (msg.id !== 1) return;
	clearTimeout(timer);
	if (msg.result?.exceptionDetails) {
		console.error(
			`page threw: ${JSON.stringify(msg.result.exceptionDetails).slice(0, 600)}`,
		);
		process.exit(1);
	}
	console.log(
		typeof msg.result?.result?.value === "string"
			? msg.result.result.value
			: JSON.stringify(msg.result?.result?.value),
	);
	ws.close();
	process.exit(0);
});
