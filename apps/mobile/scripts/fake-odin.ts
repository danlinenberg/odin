/**
 * A stand-in for Odin's phone server (apps/desktop/src/main/lib/phone), with
 * sample sessions - so the phone screens can be worked on in the Simulator
 * without a Mac-side Odin. Two ways in:
 *
 *   bun run fake-odin            prints an odin://pair link: the real
 *                                encrypted channel, as the app talks to Odin
 *   bun run sim --live           plain HTTP through the dev server (token "fake")
 *
 * Replies land in the chat (with their files' paths); uploads are counted,
 * not kept; the rest of the mutations just answer.
 */
import { acceptChannel, generateKeyPair, type Pipe } from "@odin/channel";

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
	["p6", "Old flaky CI run", "idle", "imagen", null],
	["p7", "Relay README for self-hosting", "idle", "odin", null],
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
	statusAt: Date.now() - [40, 8, 2, 95, 3, 300, 140][i] * 60_000,
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
				"3. Check the PR https://github.com/danlinenberg/odin/pull/1120 (you only)",
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
	"   3. No, and say what to do differently (esc)",
].join("\n");

/** Two profiles: Personal shows only the imagen session. */
const profiles = [
	{ id: "default", name: "Work" },
	{ id: "personal", name: "Personal" },
];
let activeProfile = "default";

function answer(path: string, input: Record<string, string> | undefined) {
	const paneId = input?.paneId ?? "";
	const session = sessions.find((s) => s.paneId === paneId);
	switch (path) {
		case "profiles":
			return { activeId: activeProfile, profiles };
		case "setProfile":
			activeProfile = input?.id ?? activeProfile;
			return null;
		case "board":
			return {
				sessions: sessions.filter(
					(s) => (s.repo === "imagen") === (activeProfile === "personal"),
				),
				backlog: [{ id: "t1", title: "Release notes for 1.4", started: false }],
				done: [
					["Remove the Telegram bot", "task", 50],
					["BUGT-3101 export stuck", "jira", 180],
					["Reply to Yuval about the HDR model", "slack", 1500],
				].map(([title, source, minutes]) => ({
					key: `${source}:${title}`,
					title,
					source,
					url: null,
					at: Date.now() - Number(minutes) * 60_000,
				})),
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
		case "links":
			return {
				prs: [
					{
						url: "https://github.com/danlinenberg/odin/pull/1120",
						label: "#1120 HDR: test for the counter rollover",
						status: { state: "MERGED", passed: 4 },
					},
					{
						url: "https://github.com/danlinenberg/odin/pull/1127",
						label: "#1127 HDR: sort brackets by capture time",
						status: {
							state: "OPEN",
							pending: ["test", "app"],
							failed: [],
							passed: 1,
						},
					},
				],
				jira: {
					url: "https://imagen.atlassian.net/browse/BUGT-3101",
					key: "BUGT-3101",
					status: "In Review",
				},
				slack: "https://imagen.slack.com/archives/C1/p1",
				notion: null,
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

async function api(req: Request, from: string): Promise<Response> {
	{
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
	}
}

/** The channel's side of a Bun socket: whatever acceptChannel hooks up. */
type Hooks = { message?: (data: Uint8Array) => void; close?: () => void };
// A fresh key each run: pair again after a restart. Any phone is welcome.
const me = generateKeyPair();

Bun.serve<Hooks>({
	port: PORT,
	fetch(req, server) {
		// Who's asking: the Simulator (127.0.0.1) or a phone on the Wi-Fi.
		const from = server.requestIP(req)?.address ?? "?";
		if (
			new URL(req.url).pathname === "/channel" &&
			server.upgrade(req, { data: {} })
		)
			return;
		return api(req, from);
	},
	websocket: {
		open(ws) {
			const pipe: Pipe = {
				send: (data) => ws.send(data),
				close: () => ws.close(),
				onMessage: (handler) => {
					ws.data.message = handler;
				},
				onClose: (handler) => {
					ws.data.close = handler;
				},
			};
			acceptChannel(pipe, {
				me,
				accept: () => true,
				handle: async (request) => {
					const answer = await api(
						new Request(`http://fake${request.path}`, {
							method: request.method,
							headers: { ...request.headers, authorization: "Bearer fake" },
							body: request.method === "GET" ? undefined : request.body.slice(),
						}),
						"channel",
					);
					return {
						status: answer.status,
						headers: {
							"content-type": answer.headers.get("content-type") ?? "",
						},
						body: new Uint8Array(await answer.arrayBuffer()),
					};
				},
			});
		},
		message(ws, message) {
			if (typeof message !== "string")
				ws.data.message?.(new Uint8Array(message));
		},
		close(ws) {
			ws.data.close?.();
		},
	},
});
const pair = new URLSearchParams({
	k: Buffer.from(me.publicKey).toString("base64url"),
	l: `ws://localhost:${PORT}/channel`,
});
console.log(`fake Odin on http://localhost:${PORT} (token: fake)`);
console.log(`pair: xcrun simctl openurl booted "odin://pair?${pair}"`);
