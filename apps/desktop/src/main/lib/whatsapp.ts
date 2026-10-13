import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { WASocket } from "@whiskeysockets/baileys";
import { NOTIFICATION_EVENTS } from "shared/constants";
import type { AgentLifecycleEvent } from "shared/notification-types";
import { ODIN_HOME_DIR } from "./app-environment";
import { askRenderer, notificationsEmitter } from "./notifications/server";

/**
 * Settings → Connections → WhatsApp: drive the board from your phone. Odin
 * links as a WhatsApp Web device (a QR scan, like web.whatsapp.com), so it
 * runs on this Mac with nothing to install and no server in between. It only
 * reads your "Message yourself" chat - nobody else can reach the board.
 *
 * Any text there becomes a backlog task, started on the board; Odin writes
 * back when that session stops and waits for you. `tasks`, `status`,
 * `start <n>` and `help` do what they say.
 */

const AUTH_DIR = join(ODIN_HOME_DIR, "whatsapp");

export type WhatsAppStatus =
	| { state: "off" | "connecting" }
	| { state: "qr"; qr: string }
	| { state: "linked"; phone: string };

let status: WhatsAppStatus = { state: "off" };
let sock: WASocket | null = null;
/**
 * Starts every reply, so Odin's own messages in the self-chat aren't read back
 * as commands - they echo in before sendMessage resolves, so ids can't tell.
 */
const MARK = "🐦‍⬛ ";
/** Titles of the tasks submitted from WhatsApp - the sessions it reports on. */
// ponytail: in memory, so a restart stops the reports for earlier tasks.
const watched = new Set<string>();
/** The last `tasks` list, so `start 2` means its second row. */
let lastTaskIds: string[] = [];
let selfChat: string | null = null;

export const whatsAppStatus = () => status;

const silent = {
	level: "silent",
	child: () => silent,
	trace() {},
	debug() {},
	info() {},
	warn() {},
	error() {},
};

/** Connect with the saved link, or show a QR to make one. */
export async function linkWhatsApp(): Promise<void> {
	if (sock) return;
	status = { state: "connecting" };
	const baileys = await import("@whiskeysockets/baileys");
	const QRCode = await import("qrcode");
	// Not a React hook, whatever the name says.
	const loadAuth = baileys.useMultiFileAuthState;
	const { state, saveCreds } = await loadAuth(AUTH_DIR);
	const socket = baileys.makeWASocket({
		auth: state,
		logger: silent,
		browser: baileys.Browsers.macOS("Odin"),
		syncFullHistory: false,
		markOnlineOnConnect: false,
	});
	sock = socket;
	const connectedAt = Math.floor(Date.now() / 1000);
	socket.ev.on("creds.update", saveCreds);
	socket.ev.on(
		"connection.update",
		async ({ connection, qr, lastDisconnect }) => {
			if (qr) status = { state: "qr", qr: await QRCode.toDataURL(qr) };
			if (connection === "open") {
				const phone = baileys.jidNormalizedUser(socket.user?.id);
				selfChat = phone;
				status = { state: "linked", phone: phone.split("@")[0] ?? phone };
			}
			if (connection === "close") {
				sock = null;
				const code = (
					lastDisconnect?.error as { output?: { statusCode?: number } }
				)?.output?.statusCode;
				if (code === baileys.DisconnectReason.loggedOut) {
					// Unlinked from the phone: forget the link so the next Link shows a QR.
					await rm(AUTH_DIR, { recursive: true, force: true });
					status = { state: "off" };
					return;
				}
				// Restart-required after the QR scan, or the network dropped.
				setTimeout(() => void linkWhatsApp(), 3_000);
			}
		},
	);
	socket.ev.on("messages.upsert", ({ messages }) => {
		const self = [socket.user?.id, socket.user?.lid].map((jid) =>
			jid ? baileys.jidNormalizedUser(jid) : "",
		);
		for (const message of messages) {
			const { key } = message;
			if (!key.fromMe) continue;
			if (!self.includes(baileys.jidNormalizedUser(key.remoteJid ?? "")))
				continue;
			// Reconnecting replays recent history; only what came after counts.
			if (Number(message.messageTimestamp ?? 0) < connectedAt) continue;
			const text =
				message.message?.conversation ??
				message.message?.extendedTextMessage?.text;
			if (!text?.trim() || text.startsWith(MARK) || !key.remoteJid) continue;
			selfChat = key.remoteJid;
			void handle(text.trim()).then(reply);
		}
	});
}

export async function unlinkWhatsApp(): Promise<void> {
	await sock?.logout().catch(() => {});
	sock = null;
	await rm(AUTH_DIR, { recursive: true, force: true });
	status = { state: "off" };
}

/** Reconnect at launch when a link was made before. */
export function startWhatsApp(): void {
	void import("node:fs").then(({ existsSync }) => {
		if (existsSync(join(AUTH_DIR, "creds.json"))) void linkWhatsApp();
	});
	notificationsEmitter.on(
		NOTIFICATION_EVENTS.AGENT_LIFECYCLE,
		(event: AgentLifecycleEvent) => void report(event),
	);
}

async function reply(text: string): Promise<void> {
	if (!sock || !selfChat) return;
	await sock.sendMessage(selfChat, { text: MARK + text }).catch(() => {});
}

type Task = { id: string; title: string; started: boolean; queued?: string };
type Session = { paneId: string; title: string; status: string };

const board = async <T>(action: string, args: Record<string, string> = {}) => {
	const text = await askRenderer(action, args);
	if (!text) throw new Error("Odin's window isn't open.");
	return JSON.parse(text) as T;
};

export const HELP = [
	"Odin on WhatsApp:",
	"- Any text: a new task, started on the board. A leading !!! makes it high priority.",
	"- tasks: the backlog, numbered",
	"- start 2: start task 2 of that list (start 1,3 for more)",
	"- status: the sessions on the board",
	"I write back when a task you sent stops and waits for you.",
].join("\n");

/** What a self-chat message asks for. */
export function parseCommand(
	text: string,
):
	| { kind: "help" }
	| { kind: "tasks" }
	| { kind: "status" }
	| { kind: "start"; rows: number[] }
	| { kind: "add"; text: string } {
	const word = text.toLowerCase();
	if (word === "help" || word === "?") return { kind: "help" };
	if (word === "tasks" || word === "backlog") return { kind: "tasks" };
	if (word === "status" || word === "sessions") return { kind: "status" };
	const start = /^start\s+([\d,\s]+)$/i.exec(text);
	if (start?.[1])
		return {
			kind: "start",
			rows: start[1]
				.split(/[,\s]+/)
				.filter(Boolean)
				.map(Number),
		};
	return { kind: "add", text };
}

async function handle(text: string): Promise<string> {
	try {
		const command = parseCommand(text);
		if (command.kind === "help") return HELP;
		if (command.kind === "tasks") {
			const tasks = await board<Task[]>("tasks");
			lastTaskIds = tasks.map((task) => task.id);
			if (tasks.length === 0) return "The backlog is empty.";
			return tasks
				.map(
					(task, i) =>
						`${i + 1}. ${task.title}${task.queued ? " (queued)" : task.started ? " (started)" : ""}`,
				)
				.join("\n");
		}
		if (command.kind === "status") {
			const sessions = await board<Session[]>("sessions");
			if (sessions.length === 0) return "No sessions on the board.";
			return sessions
				.map((session) => `- ${session.title}: ${session.status}`)
				.join("\n");
		}
		if (command.kind === "start") {
			const ids = command.rows
				.map((row) => lastTaskIds[row - 1])
				.filter((id): id is string => !!id);
			if (ids.length === 0) return "Send tasks first, then start <number>.";
			const answer = await askRenderer("start", { ids: ids.join(",") });
			const tasks = await board<Task[]>("tasks");
			for (const task of tasks)
				if (ids.includes(task.id)) watched.add(task.title);
			return answer ?? "Odin didn't answer.";
		}
		const task = await board<{ id: string; title: string }>("add", {
			text: command.text,
			start: "true",
		});
		watched.add(task.title);
		return `Started "${task.title}". I'll write when it waits for you.`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** A watched session stopped (its turn ended) or failed: say so. */
async function report(event: AgentLifecycleEvent): Promise<void> {
	if (!sock || watched.size === 0 || !event.paneId) return;
	if (event.eventType !== "Stop" && event.eventType !== "Failed") return;
	const sessions = await board<Session[]>("sessions").catch(() => []);
	const session = sessions.find((s) => s.paneId === event.paneId);
	if (!session || !watched.has(session.title)) return;
	await reply(
		event.eventType === "Failed"
			? `"${session.title}" failed. Open it in Odin.`
			: `"${session.title}" is waiting for you.`,
	);
}
