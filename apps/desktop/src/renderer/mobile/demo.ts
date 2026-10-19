/**
 * Sample sessions for the iPhone app with no Odin behind it: the app's demo
 * mode (Pair screen, "Try the demo") and `bun run fake-odin`, which serves
 * the same answers to the Simulator. Answers tRPC's batch format.
 */

type Message = {
	role: "user" | "assistant";
	text: string;
	at: string | null;
};

/** When p1's latest reply was written: its brief describes this one. */
const REPLY_AT = "2026-10-17T09:00:00.000Z";

const sessions = [
	["p1", "Fix HDR grouping test", "permission", "odin", null],
	["p2", "Shell menu cleanup", "permission", "odin", "Maya"],
	["p3", "Mobile iOS app", "working", "odin", null],
	["p4", "Voice transcribe bug", "working", "odin", null],
	["p5", "Board hover card", "review", "odin", null],
	["p6", "Old flaky CI run", "idle", "infra", null],
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
				"3. Check the PR https://github.com/acme/api/pull/1120 (you only)",
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

/** Two profiles: Personal shows only the infra session. */
const profiles = [
	{ id: "default", name: "Work" },
	{ id: "personal", name: "Personal" },
];
let activeProfile = "default";

export function answer(
	path: string,
	input: Record<string, string> | undefined,
) {
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
					(s) => (s.repo === "infra") === (activeProfile === "personal"),
				),
				backlog: [{ id: "t1", title: "Release notes for 1.4", started: false }],
				done: [
					["Remove the Telegram bot", "task", 50],
					["PAY-212 export stuck", "jira", 180],
					["Reply to Maya about the pricing model", "slack", 1500],
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
						url: "https://github.com/acme/api/pull/1120",
						label: "#1120 HDR: test for the counter rollover",
						status: { state: "MERGED", passed: 4 },
					},
					{
						url: "https://github.com/acme/api/pull/1127",
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
					url: "https://acme.atlassian.net/browse/PAY-212",
					key: "PAY-212",
					status: "In Review",
				},
				slack: "https://acme.slack.com/archives/C1/p1",
				notion: null,
			};
		case "repos":
			return [
				"/Users/you/code/api",
				"/Users/you/code/web",
				"/Users/you/code/infra",
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

/**
 * One request in tRPC's batch wire format, superjson-wrapped
 * (`{ "0": { json: input } }`), answered from the samples. `/upload` keeps
 * nothing and answers a made-up path.
 */
export function demoAnswer(
	path: string,
	query: string,
	body: string,
	log?: (path: string, input: string) => void,
): Response {
	if (path === "/upload")
		return Response.json({
			path: `/demo/attachments/${Date.now()}.${new URLSearchParams(query).get("ext")}`,
		});
	if (!path.startsWith("/trpc/")) return new Response("demo", { status: 404 });
	const raw = new URLSearchParams(query).get("input") ?? body;
	const batch = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
	return Response.json(
		path
			.slice("/trpc/".length)
			.split(",")
			.map((procedure, i) => {
				const input = (batch[i] as { json?: Record<string, string> })?.json;
				log?.(procedure, input ? JSON.stringify(input) : "");
				return { result: { data: { json: answer(procedure, input) } } };
			}),
	);
}
