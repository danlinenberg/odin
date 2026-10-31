import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
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
import { shell } from "./router";
import { hostFiles, pairingLink, startHostServer } from "./server";
import { hostPaths, hostStatus, tmux } from "./sessions";

const home = mkdtempSync(join(tmpdir(), "odin-phone-host-"));
hostPaths.home = home;

const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";

// Two of Odin's sessions in tmux, one of them stopped for being idle, and a
// tmux session that isn't Odin's.
tmux.run = async (args) => {
	if (args[0] === "list-sessions")
		return `odin-${SESSION}\tclaude\nodin-${OTHER}\tbash\nscratch\tbash\n`;
	if (args[0] === "capture-pane")
		return "✻ Cogitating… (5s · esc to interrupt)\n";
	return "";
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
				content: [{ type: "text", text: "Looking at it now." }],
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
		"Looking at it now.",
	]);
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

	// Files go through the laptop: refused here, nothing typed.
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
		(await channel.request({ ...get("board", null), path: "/upload?ext=png" }))
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
});
