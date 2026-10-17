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

type Message = {
	role: "user" | "assistant";
	text: string;
	at: string | null;
};

/** When p1's latest reply was written: its brief describes this one. */
const REPLY_AT = "2026-10-17T09:00:00.000Z";

const sessions = [
	["p1", "Fix HDR grouping test", "permission", "odin", null],
	["p2", "Shell menu cleanup", "permission", "odin", "Yuval"],
	["p3", "Mobile iOS app", "working", "odin", null],
	["p4", "Voice transcribe bug", "working", "odin", null],
	["p5", "Board hover card", "review", "odin", null],
].map(([paneId, title, column, repo, contact], i) => ({
	paneId,
	title,
	column,
	repo,
	contact,
	tags: [],
	source: "tasks",
	starred: paneId === "p4",
	// p5 ended its turn 3 minutes ago: a Just done card.
	statusAt: Date.now() - [40, 8, 2, 95, 3][i] * 60_000,
}));

const messages: Record<string, Message[]> = {
	p1: [
		{
			role: "user",
			text: "The HDR grouping test fails about 1 in 5 runs. Find out why.",
			at: null,
		},
		{ role: "assistant", text: "Reading the grouper and its tests.", at: null },
		{
			role: "assistant",
			text: "Ran the test 50 times: it fails when a bracket crosses IMG_9999.",
			at: null,
		},
		{
			role: "assistant",
			text: [
				"**Found it.** The sort uses file names, so `IMG_9999` comes before `IMG_0001` at a rollover. The camera restarts its counter at 9999, so a bracket shot across the rollover gets split in two, and the grouper then sees two brackets of two frames each instead of one bracket of four. The test only hit it when the random fixture happened to cross the rollover, about 1 in 5 runs.",
				"",
				"- Sorted by capture time instead",
				"- Added a test for the rollover",
				"- 14 pass",
				"",
				"```py",
				"brackets.sort(key=lambda p: p.captured_at)",
				"```",
				"",
				"| Before | After |",
				"| --- | --- |",
				"| 1 in 5 fail | 0 in 50 |",
				"",
				"ACTION ITEMS",
				"1. Approve running the migration on dev",
				"2. Tell me which branch to push to [main | release]",
				"3. Check the PR https://github.com/x/y/pull/1 (you only)",
			].join("\n"),
			at: REPLY_AT,
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
			return {
				tldr: "Flaky test: brackets sorted by file name. Fixed the sort, added a test. 14 pass.",
				goal: "Find why the HDR grouping test fails about 1 in 5 runs.",
				done: "Sorted brackets by capture time and added a rollover test. 14 pass.",
				status: "Waiting for approval to run the migration on dev.",
				next: "Push the fix and open a PR.",
				last: "Found it: brackets were sorted by file name. Now sorted by capture time, with a rollover test.",
				urgency: "needs-you",
				replyAt: REPLY_AT,
			};
		case "repos":
			return [
				"/Users/dan/dev/odin",
				"/Users/dan/dev/imagen",
				"/Users/dan/dev/imagen/internal-claude",
			];
		case "star": {
			if (session)
				(session as { starred: boolean }).starred = (
					input as unknown as { starred: boolean }
				).starred;
			return "ok";
		}
		case "add":
			console.log("  add", JSON.stringify(input));
			return "ok";
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
	async fetch(req, server) {
		// Who's asking: the Simulator (127.0.0.1) or a phone on the Wi-Fi.
		const from = server.requestIP(req)?.address ?? "?";
		const url = new URL(req.url);
		if (req.headers.get("authorization") !== "Bearer fake")
			return new Response(null, { status: 401 });
		if (url.pathname === "/upload") {
			const bytes = (await req.arrayBuffer()).byteLength;
			console.log(from, "upload", url.searchParams.get("ext"), bytes, "bytes");
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
				console.log(from, path, input ? JSON.stringify(input) : "");
				return { result: { data: { json: answer(path, input) } } };
			}),
		);
	},
});
console.log(`fake Odin on http://localhost:${PORT} (token: fake)`);
