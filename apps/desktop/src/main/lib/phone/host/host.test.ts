import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connectChannel,
	connectSocket,
	generateKeyPair,
	relayId,
	websocketPipe,
} from "@odin/channel";
import { startRelay } from "@odin/relay";
import { endedTurn, github, hostPhoneRouter, shell } from "./router";
import { hostFiles, hostLink, pairingLink, startHostServer } from "./server";
import {
	hostPaths,
	hostSessions,
	hostStatus,
	parseStars,
	procs,
	starMarks,
	tmux,
} from "./sessions";

const home = mkdtempSync(join(tmpdir(), "odin-phone-host-"));
hostPaths.home = home;

const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";

// Two of Odin's sessions in tmux, one of them stopped for being idle, and a
// tmux session that isn't Odin's. Each pane's command is the run script's
// bash: Claude is its child.
let listed = `odin-${SESSION}\t101\t1000\nodin-${OTHER}\t102\t1000\nscratch\t103\t1000\n`;
procs.claudeParents = async () => new Set(["101"]);
tmux.run = async (args) => {
	if (args[0] === "list-sessions") return listed;
	if (args[0] === "capture-pane")
		return "✻ Cogitating… (5s · esc to interrupt)\n";
	return "";
};
// gh on the host answers for the PR the conversation links.
const asked: string[] = [];
github.state = async (url) => {
	asked.push(url);
	return {
		state: "MERGED",
		isDraft: false,
		approved: true,
		pending: [],
		awaiting: [],
		failed: [],
		passed: 3,
		conflicting: false,
		base: "main",
		author: "me",
		mine: true,
		title: "Fix the flaky login test",
		summary: null,
	};
};
const typed: string[] = [];
shell.run = async (script) => {
	typed.push(script);
	return 0;
};

const project = join(home, ".claude", "projects", "-home-u-repos-odin");
mkdirSync(project, { recursive: true });
const line = (entry: object) => `${JSON.stringify(entry)}\n`;
writeFileSync(
	join(project, `${SESSION}.jsonl`),
	line({
		type: "user",
		timestamp: "2026-10-31T08:00:00.000Z",
		cwd: "/home/u/repos/odin",
		message: { role: "user", content: "Fix the flaky login test" },
	}) +
		line({
			type: "assistant",
			timestamp: "2026-10-31T08:00:05.000Z",
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: "Looking at it now. https://github.com/acme/app/pull/12",
					},
				],
				stop_reason: "end_turn",
			},
		}),
);
// The laptop's card for the first session, from the run script's file.
mkdirSync(join(home, ".odin", "panes"), { recursive: true });
writeFileSync(join(home, ".odin", "panes", `odin-${SESSION}`), "pane-abc");

const relay = startRelay({ port: 0, hostname: "127.0.0.1" });
const base = `ws://127.0.0.1:${relay.port}`;
let server: ReturnType<typeof startHostServer> = null;

beforeAll(async () => {
	writeFileSync(
		hostFiles().config,
		JSON.stringify({ relay: base, name: "dev-box" }),
	);
	server = startHostServer();
	await Bun.sleep(100);
});
afterAll(() => {
	server?.stop();
	void relay.stop(true);
});

const me = generateKeyPair();
const decode = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body));

async function phone(code?: string) {
	const link = new URL(pairingLink());
	const host = Uint8Array.from(
		Buffer.from(link.searchParams.get("k") ?? "", "base64url"),
	);
	return connectChannel(
		websocketPipe(await connectSocket(`${base}/connect/${relayId(host)}`)),
		{ me, host, hello: { v: 1, code, name: "Test iPhone" } },
	);
}

const get = (path: string, input: unknown) => ({
	method: "GET",
	path: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
	headers: {},
	body: new Uint8Array(0),
});

test("the host keeps its own key, 0600, and a second start leaves the first running", () => {
	expect(statSync(hostFiles().identity).mode & 0o777).toBe(0o600);
	expect(statSync(hostPaths.dir).mode & 0o777).toBe(0o700);
	expect(startHostServer()).toBeNull();
});

test("the pairing link names the host and its relay, and has no Wi-Fi address", () => {
	const link = new URL(pairingLink());
	expect(link.searchParams.get("r")).toBe(base);
	expect(link.searchParams.get("h")).toBe("dev-box");
	expect(link.searchParams.get("l")).toBeNull();
	expect(statSync(hostFiles().code).mode & 0o777).toBe(0o600);
});

test("the link for the laptop's phones is the same host and relay, with no code", () => {
	const link = new URL(hostLink());
	const paired = new URL(pairingLink());
	expect(link.searchParams.get("k")).toBe(paired.searchParams.get("k"));
	expect(link.searchParams.get("r")).toBe(base);
	expect(link.searchParams.get("h")).toBe("dev-box");
	expect(link.searchParams.get("c")).toBeNull();
});

/** Refused: the handshake fails, or the relay never joins a phone the host hung up on. */
const refused = (attempt: Promise<unknown>) =>
	Promise.race([
		attempt.then(
			() => "paired",
			() => "refused",
		),
		Bun.sleep(1_500).then(() => "refused"),
	]);

test("a phone without the code gets no channel", async () => {
	expect(await refused(phone())).toBe("refused");
	expect(await refused(phone("wrong"))).toBe("refused");
});

test("a paired phone lists the host's sessions, reads one, and replies", async () => {
	const code = new URL(pairingLink()).searchParams.get("c") ?? "";
	const channel = await phone(code);

	const board = decode((await channel.request(get("board", null))).body).result
		.data.json;
	expect(board.via).toEqual({ host: "the remote host" });
	expect(board.sessions.map((s: { paneId: string }) => s.paneId)).toEqual([
		"pane-abc",
		OTHER,
	]);
	const [first, second] = board.sessions;
	expect(first.title).toBe("Fix the flaky login test");
	expect(first.column).toBe("working");
	// Claude stopped for being idle: the run script waits at its own prompt.
	expect(second.column).toBe("idle");

	const session = decode(
		(await channel.request(get("session", { paneId: "pane-abc" }))).body,
	).result.data.json;
	expect(session.messages.map((m: { text: string }) => m.text)).toEqual([
		"Fix the flaky login test",
		"Looking at it now. https://github.com/acme/app/pull/12",
	]);

	// Its PR, read from the conversation here, with its state from gh here.
	const links = decode(
		(await channel.request(get("links", { paneId: "pane-abc" }))).body,
	).result.data.json;
	expect(asked).toEqual(["https://github.com/acme/app/pull/12"]);
	expect(links.prs).toHaveLength(1);
	expect(links.prs[0].url).toBe("https://github.com/acme/app/pull/12");
	expect(links.prs[0].repo).toBe("app");
	expect(links.prs[0].label).toBe("#12 Fix the flaky login test");
	expect(links.prs[0].status).toMatchObject({ state: "MERGED", passed: 3 });
	expect(session.status).toBe("working");

	const reply = await channel.request({
		method: "POST",
		path: "/trpc/reply",
		headers: { "content-type": "application/json" },
		body: new TextEncoder().encode(
			JSON.stringify({ json: { paneId: "pane-abc", text: "two\nlines" } }),
		),
	});
	expect(reply.status).toBe(200);
	expect(decode(reply.body).result.data.json.via.host).toBeTruthy();
	const script = typed.at(-1) ?? "";
	// Typed into that session's tmux, as one bracketed paste, then Enter.
	expect(script).toContain(`tmux has-session -t 'odin-${SESSION}'`);
	expect(script).toContain("paste-buffer -p");
	expect(script).toContain(Buffer.from("two\nlines").toString("base64"));
	expect(script).toMatch(/send-keys -t 'odin-[^']+' Enter/);

	// A photo from the phone is kept here, 0600, and a reply names it above the text.
	const sent = await channel.request({
		method: "POST",
		path: "/upload?ext=png",
		headers: { "content-type": "image/png" },
		body: new Uint8Array([1, 2, 3]),
	});
	expect(sent.status).toBe(200);
	const photo = decode(sent.body).path as string;
	expect(photo.startsWith(join(home, ".odin", "attachments"))).toBe(true);
	expect(statSync(photo).mode & 0o777).toBe(0o600);
	const withPhoto = await channel.request({
		method: "POST",
		path: "/trpc/reply",
		headers: { "content-type": "application/json" },
		body: new TextEncoder().encode(
			JSON.stringify({
				json: { paneId: "pane-abc", text: "see", paths: [photo] },
			}),
		),
	});
	expect(withPhoto.status).toBe(200);
	expect(typed.at(-1)).toContain(
		Buffer.from(`${photo}\nsee`).toString("base64"),
	);

	// A file that isn't one the phone uploaded here is refused, nothing typed.
	const count = typed.length;
	const files = await channel.request({
		method: "POST",
		path: "/trpc/reply",
		headers: { "content-type": "application/json" },
		body: new TextEncoder().encode(
			JSON.stringify({
				json: { paneId: "pane-abc", text: "see", paths: ["/tmp/a.png"] },
			}),
		),
	});
	expect(files.status).toBe(412);
	expect(typed.length).toBe(count);
	expect(
		(await channel.request({ ...get("board", null), path: "/upload?ext=sh;x" }))
			.status,
	).toBe(400);

	// A star with the Mac away is kept here and shows on this board.
	const star = await channel.request({
		method: "POST",
		path: "/trpc/star",
		headers: { "content-type": "application/json" },
		body: new TextEncoder().encode(
			JSON.stringify({ json: { paneId: "pane-abc", starred: true } }),
		),
	});
	expect(star.status).toBe(200);
	expect(starMarks().get("pane-abc")).toBe(true);
	const starredBoard = decode((await channel.request(get("board", null))).body)
		.result.data.json;
	expect(
		starredBoard.sessions.map((s: { starred: boolean }) => s.starred),
	).toEqual([true, false]);

	// The board's batch beside the profile picker still gets its answer.
	const batch = await channel.request({
		method: "GET",
		path: `/trpc/board,profiles?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: null }, 1: { json: null } }))}`,
		headers: {},
		body: new Uint8Array(0),
	});
	expect(batch.status).toBe(200);
	expect(decode(batch.body)[1].result.data.json.profiles).toEqual([]);

	// Only the API answers.
	expect(
		(await channel.request({ ...get("board", null), path: "/odin?action=x" }))
			.status,
	).toBe(404);
	channel.close();
});

test("a session that ended on the host says so", async () => {
	shell.run = async () => 3;
	const channel = await phone();
	const reply = await channel.request({
		method: "POST",
		path: "/trpc/reply",
		headers: { "content-type": "application/json" },
		body: new TextEncoder().encode(
			JSON.stringify({ json: { paneId: OTHER, text: "hi" } }),
		),
	});
	expect(reply.status).toBe(412);
	expect(JSON.stringify(decode(reply.body))).toContain(
		"ended on the remote host",
	);
	channel.close();
});

test("status: the screen's dialog or spinner wins; at the prompt the laptop's last word stands", () => {
	expect(hostStatus("anything", false, "working")).toBe("idle");
	expect(hostStatus("❯ 1. Yes\nEnter to confirm", true, "review")).toBe(
		"permission",
	);
	expect(hostStatus("? for shortcuts", true, "permission")).toBe("permission");
	expect(hostStatus("? for shortcuts", true, "working")).toBe("review");
	const agentsOut = [
		"─".repeat(40),
		"❯ ",
		"─".repeat(40),
		"  ⏵⏵ bypass permissions on (shift+tab to cycle)",
		"  ◯ general-purpose  Searching… 1m 2s · ↓ 9.1k tokens",
	].join("\n");
	expect(hostStatus(agentsOut, true, "working")).toBe("working");
	expect(hostStatus(agentsOut, true, "permission")).toBe("permission");
});

test("status: a turn that ended after the Mac's last board is filed by its own action items", () => {
	const asks = { asks: true };
	const none = { asks: false };
	// At the prompt, a newer turn outranks the Mac's stale word.
	expect(hostStatus("? for shortcuts", true, "review", asks)).toBe(
		"permission",
	);
	expect(hostStatus("? for shortcuts", true, "working", asks)).toBe(
		"permission",
	);
	expect(hostStatus("? for shortcuts", true, "permission", none)).toBe(
		"review",
	);
	// A Claude stopped here still owes you what it asked.
	expect(hostStatus("", false, "permission")).toBe("permission");
	expect(hostStatus("", false, "review", asks)).toBe("permission");
	expect(hostStatus("", false, "review", none)).toBe("idle");
});

test("endedTurn: only a reply written after the board was sent counts", () => {
	const sentAt = Date.parse("2026-01-01T10:00:00Z") / 1000;
	const reply = (text: string, at: string) => [
		{ role: "user", text: "go", at },
		{ role: "assistant", text, at },
	];
	const open = "Done.\n\nACTION ITEMS\n1. Merge the PR";
	expect(endedTurn(reply(open, "2026-01-01T11:00:00Z"), sentAt)).toEqual({
		asks: true,
	});
	expect(
		endedTurn(
			reply("Shipped.\n\nACTION ITEMS: none", "2026-01-01T11:00:00Z"),
			sentAt,
		),
	).toEqual({ asks: false });
	expect(endedTurn(reply(open, "2026-01-01T09:00:00Z"), sentAt)).toBeNull();
	// Mid-turn: the last message is yours, nothing ended yet.
	expect(
		endedTurn(
			[{ role: "user", text: "go", at: "2026-01-01T11:00:00Z" }],
			sentAt,
		),
	).toBeNull();
});

test("a session the Mac's board no longer has is left out, unless it started after the board was sent", async () => {
	const before = listed;
	const board = join(hostPaths.dir, "board.json");
	const sent = 2_000_000;
	const DONE = "aaaaaaaa-2222-3333-4444-555555555555";
	const NEW = "bbbbbbbb-2222-3333-4444-555555555555";
	// On the Mac's board, marked Done there (tmux still has it), started since.
	listed = `odin-${SESSION}\t101\t1000\nodin-${DONE}\t104\t${sent - 3600}\nodin-${NEW}\t105\t${sent + 60}\n`;
	writeFileSync(
		board,
		JSON.stringify({ sessions: [{ paneId: "pane-abc", sessionId: SESSION }] }),
	);
	utimesSync(board, sent, sent);
	try {
		expect((await hostSessions()).map((s) => s.sessionId)).toEqual([
			SESSION,
			NEW,
		]);
	} finally {
		listed = before;
		rmSync(board);
	}
});

test("the last star line for a session stands; a broken line is skipped", () => {
	const stars = parseStars(
		'{"paneId":"a","starred":true,"at":1}\nnot json\n{"paneId":"a","starred":false,"at":2}\n{"paneId":"b","starred":true,"at":3}\n',
	);
	expect([...stars]).toEqual([
		["a", false],
		["b", true],
	]);
});

test("a session the phone started here is named after its task, not its opening instructions", async () => {
	mkdirSync(join(home, ".odin", "night"), { recursive: true });
	writeFileSync(
		join(home, ".odin", "night", "ran.jsonl"),
		`${JSON.stringify({ key: "task:1", sessionId: OTHER, title: "Ship the invoice export", away: true })}\n`,
	);
	const board = await hostPhoneRouter.createCaller({}).board();
	expect(board.sessions.find((s) => s.paneId === OTHER)?.title).toBe(
		"Ship the invoice export",
	);
});
