/**
 * A stand-in for Odin's phone server (apps/desktop/src/main/lib/phone), with
 * sample sessions - so the phone screens can be worked on in the Simulator
 * without a Mac-side Odin. Pair the Simulator with it:
 *
 *   bun run fake-odin
 *   xcrun simctl openurl booted "odin://pair?u=http%3A%2F%2Flocalhost%3A4799%2F%3Ft%3Dfake"
 *
 * Replies land in the chat (with their files' paths); uploads are counted,
 * not kept; the rest of the mutations just answer.
 */
const PORT = 4799;

type Message = { role: "user" | "assistant"; text: string; at: null };

const sessions = [
	["p1", "Fix HDR grouping test", "permission", "odin", null],
	["p2", "Shell menu cleanup", "permission", "odin", "Yuval"],
	["p3", "Mobile iOS app", "working", "odin", null],
	["p4", "Voice transcribe bug", "working", "odin", null],
	["p5", "Board hover card", "review", "odin", null],
].map(([paneId, title, column, repo, contact]) => ({
	paneId,
	title,
	column,
	repo,
	contact,
	tags: [],
	source: "tasks",
}));

const messages: Record<string, Message[]> = {
	p1: [
		{
			role: "user",
			text: "The HDR grouping test fails about 1 in 5 runs. Find out why.",
			at: null,
		},
		{
			role: "assistant",
			text: "The sort uses file names, so IMG_9999 comes before IMG_0001 at a rollover. I now sort by capture time and added a test. 14 pass.",
			at: null,
		},
	],
};

// A long one, to scroll.
messages.p3 = Array.from({ length: 24 }, (_, i) => ({
	role: i % 2 ? "assistant" : "user",
	text:
		i % 2
			? `Step ${(i + 1) / 2}: built the screen, checked it in the Simulator, fixed what looked off.`
			: `Next: part ${i / 2 + 1}.`,
	at: null,
}));

const screen = [
	" Bash command",
	"   alembic upgrade head",
	" Do you want to proceed?",
	" ❯ 1. Yes",
	"   2. Yes, and don't ask again",
	"   3. No, and tell Claude what to do differently (esc)",
].join("\n");

function answer(path: string, input: Record<string, string> | undefined) {
	const paneId = input?.paneId ?? "";
	const session = sessions.find((s) => s.paneId === paneId);
	switch (path) {
		case "board":
			return {
				sessions,
				backlog: [{ id: "t1", title: "Release notes for 1.4", started: false }],
			};
		case "session":
			return {
				title: session?.title ?? "Session",
				status: session?.column ?? "idle",
				messages: messages[paneId] ?? [],
				screen: session?.column === "permission" ? screen : "",
			};
		case "brief":
			return "Flaky test: brackets sorted by file name. Fixed the sort, added a test. 14 pass.";
		case "reply":
			messages[paneId] ??= [];
			messages[paneId].push({
				role: "user",
				text: [...((input?.paths as unknown as string[]) ?? []), input?.text]
					.filter(Boolean)
					.join("\n"),
				at: null,
			});
			return null;
		default:
			return null;
	}
}

/** tRPC's batch wire format, superjson-wrapped: `{ "0": { json: input } }`. */
async function inputs(
	req: Request,
	url: URL,
): Promise<Record<string, unknown>> {
	const raw =
		req.method === "GET" ? url.searchParams.get("input") : await req.text();
	return raw ? JSON.parse(raw) : {};
}

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (req.headers.get("authorization") !== "Bearer fake")
			return new Response(null, { status: 401 });
		if (url.pathname === "/upload") {
			const bytes = (await req.arrayBuffer()).byteLength;
			console.log("upload", url.searchParams.get("ext"), bytes, "bytes");
			return Response.json({
				path: `/fake/attachments/${Date.now()}.${url.searchParams.get("ext")}`,
			});
		}
		if (!url.pathname.startsWith("/trpc/"))
			return new Response("fake Odin", { status: 404 });
		const batch = await inputs(req, url);
		const paths = url.pathname.slice("/trpc/".length).split(",");
		return Response.json(
			paths.map((path, i) => {
				const input = (batch[i] as { json?: Record<string, string> })?.json;
				console.log(path, input ? JSON.stringify(input) : "");
				return { result: { data: { json: answer(path, input) } } };
			}),
		);
	},
});
console.log(`fake Odin on http://localhost:${PORT} (token: fake)`);
