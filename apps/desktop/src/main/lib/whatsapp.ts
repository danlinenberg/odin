import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WASocket } from "@whiskeysockets/baileys";
import { NOTIFICATION_EVENTS } from "shared/constants";
import type { AgentLifecycleEvent } from "shared/notification-types";
import { ODIN_HOME_DIR } from "./app-environment";
import { askRenderer, notificationsEmitter } from "./notifications/server";

/**
 * Settings → Connections → WhatsApp: drive the board from your phone. Odin
 * links as a WhatsApp Web device (a QR scan, like web.whatsapp.com) of a
 * second number - its own account, so it shows as a contact named Odin with
 * Odin's icon, and your own profile stays yours. It runs on this Mac with
 * nothing to install and no server in between.
 *
 * Only the owner reaches the board: the first chat to send the pairing code
 * Settings shows. Any text from them becomes a backlog task, started on the
 * board; Odin writes back when that session stops and waits for them.
 * `tasks`, `status`, `start <n>` and `help` do what they say.
 */

const AUTH_DIR = join(ODIN_HOME_DIR, "whatsapp");
const OWNER_FILE = join(AUTH_DIR, "owner.json");

export type WhatsAppStatus =
	| { state: "off" | "connecting" }
	| { state: "qr"; qr: string }
	/** code: the pairing code to send, until an owner has sent it. */
	| { state: "linked"; phone: string; code?: string };

/**
 * Who the bot answers: the jids WhatsApp gives their chat (a phone jid and
 * its @lid), and the chat to write to. profileSet: Odin's name and icon are
 * on the account.
 */
type Owner = { jids: string[]; chat: string; profileSet?: boolean };

let status: WhatsAppStatus = { state: "off" };
let sock: WASocket | null = null;
let owner: Owner | null = null;
let pairCode = "";
/** Titles of the tasks submitted from WhatsApp - the sessions it reports on. */
// ponytail: in memory, so a restart stops the reports for earlier tasks.
const watched = new Set<string>();
/** The last `tasks` list, so `start 2` means its second row. */
let lastTaskIds: string[] = [];

export const whatsAppStatus = () => status;

/** Baileys' own warnings and errors, in Odin's log; the rest is noise. */
const logger = {
	level: "warn",
	child: () => logger,
	trace() {},
	debug() {},
	info() {},
	warn: (obj: unknown, msg?: string) =>
		console.warn("[whatsapp]", msg ?? "", obj),
	error: (obj: unknown, msg?: string) =>
		console.warn("[whatsapp] error", msg ?? "", obj),
};

function readOwner(): Owner | null {
	try {
		return JSON.parse(readFileSync(OWNER_FILE, "utf8")) as Owner;
	} catch {
		return null;
	}
}

async function saveOwner(next: Owner): Promise<void> {
	owner = next;
	await writeFile(OWNER_FILE, JSON.stringify(next));
}

/**
 * Odin's name and icon on the bot account, once per link. Baileys' own
 * updateProfilePicture needs sharp or jimp; Electron's nativeImage makes the
 * same 640px JPEG, so this sends the query that function wraps.
 */
async function setProfile(socket: WASocket): Promise<void> {
	if (!owner || owner.profileSet) return;
	// Lazy: both reach Electron's nativeImage, which tests can't load.
	const { nativeImage } = await import("electron");
	const { getIconPath } = await import("./dock-icon");
	const img = nativeImage
		.createFromPath(getIconPath())
		.resize({ width: 640, height: 640 })
		.toJPEG(80);
	await socket.query({
		tag: "iq",
		attrs: { to: "s.whatsapp.net", type: "set", xmlns: "w:profile:picture" },
		content: [{ tag: "picture", attrs: { type: "image" }, content: img }],
	});
	await socket.updateProfileName("Odin");
	await saveOwner({ ...owner, profileSet: true });
}

/** Connect with the saved link, or show a QR to make one. */
export async function linkWhatsApp(): Promise<void> {
	if (sock) return;
	status = { state: "connecting" };
	const baileys = await import("@whiskeysockets/baileys");
	const QRCode = await import("qrcode");
	// Not a React hook, whatever the name says.
	const loadAuth = baileys.useMultiFileAuthState;
	const { state, saveCreds } = await loadAuth(AUTH_DIR);
	owner = readOwner();
	pairCode ||= String(randomInt(100_000, 1_000_000));
	// The version Baileys ships goes stale, and the phone then refuses to link
	// ("Couldn't link device"); ask web.whatsapp.com for the current one.
	const { version } = await baileys.fetchLatestWaWebVersion({});
	const socket = baileys.makeWASocket({
		auth: state,
		version,
		logger,
		browser: baileys.Browsers.macOS("Odin"),
		syncFullHistory: false,
		markOnlineOnConnect: false,
	});
	sock = socket;
	const connectedAt = Math.floor(Date.now() / 1000);
	const profile = () =>
		setProfile(socket).catch((error) =>
			console.warn("[whatsapp] couldn't set Odin's name and icon:", error),
		);
	socket.ev.on("creds.update", saveCreds);
	socket.ev.on(
		"connection.update",
		async ({ connection, qr, lastDisconnect }) => {
			if (qr) status = { state: "qr", qr: await QRCode.toDataURL(qr) };
			if (connection === "open") {
				const jid = baileys.jidNormalizedUser(socket.user?.id);
				status = {
					state: "linked",
					phone: jid.split("@")[0] ?? jid,
					...(!owner && { code: pairCode }),
				};
				void profile();
			}
			if (connection === "close") {
				sock = null;
				const code = (
					lastDisconnect?.error as { output?: { statusCode?: number } }
				)?.output?.statusCode;
				console.warn(
					"[whatsapp] closed:",
					code,
					lastDisconnect?.error?.message,
				);
				if (code === baileys.DisconnectReason.loggedOut) {
					// Unlinked from the phone: forget the link so the next Link shows a QR.
					await rm(AUTH_DIR, { recursive: true, force: true });
					owner = null;
					status = { state: "off" };
					return;
				}
				// Nobody scanned the QR in time: stop, so it doesn't make new ones
				// in the background forever. Link starts over.
				if (code === baileys.DisconnectReason.timedOut && !state.creds.me) {
					status = { state: "off" };
					return;
				}
				// Restart-required after the QR scan, or the network dropped.
				setTimeout(() => void linkWhatsApp(), 3_000);
			}
		},
	);
	socket.ev.on("messages.upsert", ({ messages }) => {
		for (const message of messages) {
			const { key } = message;
			const chat = key.remoteJid;
			// One-to-one chats from someone else only: no groups, no echoes.
			if (key.fromMe || !chat || chat.endsWith("@g.us")) continue;
			// Reconnecting replays recent history; only what came after counts.
			if (Number(message.messageTimestamp ?? 0) < connectedAt) continue;
			const text = (
				message.message?.conversation ??
				message.message?.extendedTextMessage?.text
			)?.trim();
			if (!text) continue;
			const jids = [chat, key.remoteJidAlt]
				.filter((jid): jid is string => !!jid)
				.map((jid) => baileys.jidNormalizedUser(jid));
			if (!owner) {
				if (text !== pairCode) continue;
				void saveOwner({ jids, chat }).then(async () => {
					if (status.state === "linked")
						status = { state: "linked", phone: status.phone };
					await reply(`Paired. This chat drives Odin now.\n\n${HELP}`);
					await profile();
				});
				continue;
			}
			if (!jids.some((jid) => owner?.jids.includes(jid))) continue;
			void handle(text).then(reply);
		}
	});
}

export async function unlinkWhatsApp(): Promise<void> {
	await sock?.logout().catch(() => {});
	sock = null;
	owner = null;
	pairCode = "";
	await rm(AUTH_DIR, { recursive: true, force: true });
	status = { state: "off" };
}

/** Reconnect at launch when a link was made before. */
export function startWhatsApp(): void {
	if (existsSync(join(AUTH_DIR, "creds.json"))) void linkWhatsApp();
	notificationsEmitter.on(
		NOTIFICATION_EVENTS.AGENT_LIFECYCLE,
		(event: AgentLifecycleEvent) => void report(event),
	);
}

async function reply(text: string): Promise<void> {
	if (!sock || !owner) return;
	await sock.sendMessage(owner.chat, { text }).catch(() => {});
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

/** What a message from the owner asks for. */
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
