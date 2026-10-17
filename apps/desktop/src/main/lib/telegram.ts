import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NOTIFICATION_EVENTS } from "shared/constants";
import type { AgentLifecycleEvent } from "shared/notification-types";
import { ODIN_HOME_DIR } from "./app-environment";
import { askRenderer, notificationsEmitter } from "./notifications/server";
import { callProcedure } from "./odin-api";

/**
 * Settings → Connections → Telegram: drive the board from your phone. You make
 * a bot with @BotFather and paste its token; Odin long-polls Telegram's Bot API
 * from this Mac - no server, no webhook, nothing to install - and gives the bot
 * Odin's name and icon.
 *
 * Only the owner reaches the board: the first chat to open the bot through the
 * pairing link Settings shows. Any text from them becomes a backlog task,
 * started on the board; Odin writes back when that session stops and waits for
 * them, with the end of its screen; reply to that message to answer the
 * session. /tasks, /status, start <n>, screen <n>, done <n> and /help do what
 * they say.
 */

const CONFIG_FILE = join(ODIN_HOME_DIR, "telegram.json");

export type TelegramStatus =
	| { state: "off" }
	| { state: "error"; error: string }
	/** pairLink: the t.me link that pairs the owner, until one has. */
	| { state: "connected"; bot: string; pairLink?: string };

/** owner: the chat the bot answers. profileSet: Odin's name and icon are on the bot. */
type Config = {
	token: string;
	bot: string;
	owner?: number;
	profileSet?: boolean;
};

let config: Config | null = null;
let status: TelegramStatus = { state: "off" };
let polling: AbortController | null = null;
let pairCode = "";
/** Titles of the tasks submitted from Telegram - the sessions it reports on. */
const watched = new Set<string>();
/** The last /tasks list, so `start 2` means its second row. */
let lastTaskIds: string[] = [];
/** The last /status list, so `screen 2` means its second row. */
let lastPaneIds: string[] = [];
/** "Waiting for you" message id -> its session, so a reply reaches the pane. */
const alertPanes = new Map<number, string>();

export const telegramStatus = () => status;

async function api<T>(
	token: string,
	method: string,
	body: Record<string, unknown> | FormData = {},
	signal?: AbortSignal,
): Promise<T> {
	const response = await fetch(
		`https://api.telegram.org/bot${token}/${method}`,
		{
			method: "POST",
			...(body instanceof FormData
				? { body }
				: {
						body: JSON.stringify(body),
						headers: { "content-type": "application/json" },
					}),
			signal,
		},
	);
	const data = (await response.json()) as {
		ok: boolean;
		result: T;
		description?: string;
	};
	if (!data.ok)
		throw new Error(data.description ?? `Telegram ${method} failed.`);
	return data.result;
}

async function save(next: Config): Promise<void> {
	config = next;
	// The token runs the bot, so only this user can read it.
	await writeFile(CONFIG_FILE, JSON.stringify(next), { mode: 0o600 });
}

function refreshStatus(): void {
	if (!config) return;
	status = {
		state: "connected",
		bot: config.bot,
		...(!config.owner && {
			pairLink: `https://t.me/${config.bot}?start=${pairCode}`,
		}),
	};
}

/** Odin's name, icon, description and command menu on the bot, once. */
async function setProfile(current: Config): Promise<void> {
	if (current.profileSet) return;
	const { token } = current;
	// Lazy: both reach Electron's nativeImage, which tests can't load.
	const { nativeImage } = await import("electron");
	const { getIconPath } = await import("./dock-icon");
	const jpeg = nativeImage
		.createFromPath(getIconPath())
		.resize({ width: 640, height: 640 })
		.toJPEG(90);
	const form = new FormData();
	form.append(
		"photo",
		JSON.stringify({ type: "static", photo: "attach://icon" }),
	);
	form.append(
		"icon",
		new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }),
		"odin.jpg",
	);
	await api(token, "setMyProfilePhoto", form);
	await api(token, "setMyName", { name: "Odin" });
	await api(token, "setMyDescription", {
		description:
			"Odin's board on your phone: send a task to start it, and hear back when it waits for you.",
	});
	await api(token, "setMyCommands", {
		commands: [
			{ command: "tasks", description: "The backlog, numbered" },
			{ command: "status", description: "The sessions on the board" },
			{ command: "screen", description: "screen 2: what session 2 shows" },
			{ command: "help", description: "What I can do" },
		],
	});
	await save({ ...current, profileSet: true });
}

type Message = {
	chat: { id: number; type: string };
	text?: string;
	reply_to_message?: { message_id: number };
};

async function poll(token: string, signal: AbortSignal): Promise<void> {
	let offset = 0;
	while (!signal.aborted) {
		try {
			const updates = await api<{ update_id: number; message?: Message }[]>(
				token,
				"getUpdates",
				{ offset, timeout: 50, allowed_updates: ["message"] },
				signal,
			);
			if (status.state === "error") refreshStatus();
			for (const update of updates) {
				offset = update.update_id + 1;
				if (update.message) await onMessage(update.message);
			}
		} catch (error) {
			if (signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			console.warn("[telegram] polling:", message);
			// A revoked token never comes back; anything else is the network.
			if (/unauthorized/i.test(message)) {
				status = {
					state: "error",
					error: "Telegram rejected the bot token. Connect again.",
				};
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 5_000));
		}
	}
}

async function onMessage(message: Message): Promise<void> {
	const text = message.text?.trim();
	if (!config || !text || message.chat.type !== "private") return;
	if (!config.owner) {
		if (text !== `/start ${pairCode}`) return;
		await save({ ...config, owner: message.chat.id });
		refreshStatus();
		await reply(`Paired. This chat drives Odin now.\n\n${HELP}`);
		return;
	}
	if (message.chat.id !== config.owner) return;
	const paneId = alertPanes.get(message.reply_to_message?.message_id ?? 0);
	await reply(paneId ? await answerSession(paneId, text) : await handle(text));
}

function start(next: Config): void {
	config = next;
	pairCode ||= String(randomInt(100_000, 1_000_000));
	refreshStatus();
	polling?.abort();
	polling = new AbortController();
	void poll(next.token, polling.signal);
	void setProfile(next).catch((error) =>
		console.warn("[telegram] couldn't set Odin's name and icon:", error),
	);
}

/** Check a @BotFather token, save it and start answering. */
export async function connectTelegram(token: string): Promise<void> {
	const me = await api<{ username: string }>(token.trim(), "getMe").catch(
		() => {
			throw new Error(
				"Telegram didn't accept that token. Copy it again from @BotFather.",
			);
		},
	);
	const fresh: Config = { token: token.trim(), bot: me.username };
	await save(fresh);
	start(fresh);
}

export async function disconnectTelegram(): Promise<void> {
	polling?.abort();
	polling = null;
	config = null;
	pairCode = "";
	await rm(CONFIG_FILE, { force: true });
	status = { state: "off" };
}

/** Pick up a saved bot at launch. */
export function startTelegram(): void {
	try {
		start(JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config);
	} catch {
		// Not connected.
	}
	notificationsEmitter.on(
		NOTIFICATION_EVENTS.AGENT_LIFECYCLE,
		(event: AgentLifecycleEvent) => void report(event),
	);
}

/** The sent message's id, or undefined when it didn't go. */
async function reply(text: string): Promise<number | undefined> {
	if (!config?.owner) return;
	const sent = await api<{ message_id: number }>(config.token, "sendMessage", {
		chat_id: config.owner,
		text,
	}).catch((error) => console.warn("[telegram] send:", error));
	return sent?.message_id;
}

/** The end of a session's screen, short enough for one Telegram message. */
export function screenTail(raw: string): string {
	let text = raw;
	try {
		text = (JSON.parse(raw) as { text: string }).text;
	} catch {
		// callProcedure's own error text: show it as is.
	}
	const lines = text.split("\n").filter((line) => line.trim());
	return lines.slice(-20).join("\n").slice(-3500);
}

const readScreen = async (paneId: string) =>
	screenTail(
		await callProcedure("terminal.readScreen", JSON.stringify({ paneId })),
	);

/**
 * The writes that type a reply into Claude and send it, as the chat view's
 * typeIntoClaude does: multi-line text as one bracketed paste, so its first
 * newline doesn't send it early, then Enter on its own.
 */
export function answerWrites(text: string): [string, string] {
	return [text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text, "\r"];
}

/** Text typed into the session, then Enter. */
async function answerSession(paneId: string, text: string): Promise<string> {
	const [typed, enter] = answerWrites(text);
	const write = (data: string) =>
		callProcedure("terminal.write", JSON.stringify({ paneId, data }));
	const result = await write(typed);
	if (result.startsWith("Failed")) return result;
	await new Promise((resolve) => setTimeout(resolve, 30));
	const sent = await write(enter);
	return sent.startsWith("Failed") ? sent : "Sent.";
}

type Task = { id: string; title: string; started: boolean; queued?: string };
type Session = { paneId: string; title: string; status: string };

const board = async <T>(action: string, args: Record<string, string> = {}) => {
	const text = await askRenderer(action, args);
	if (!text) throw new Error("Odin's window isn't open.");
	return JSON.parse(text) as T;
};

export const HELP = [
	"Odin on Telegram:",
	"- Any text: a new task, started on the board. A leading !!! makes it high priority.",
	"- /tasks: the backlog, numbered",
	"- start 2: start task 2 of that list (start 1,3 for more)",
	"- /status: the sessions on the board, numbered",
	"- screen 2: the end of session 2's screen",
	"- done 2: mark session 2 done",
	"I write back when a task you sent stops and waits for you. Reply to that message to answer the session.",
].join("\n");

/** What a message from the owner asks for. Commands work with or without the "/". */
export function parseCommand(
	text: string,
):
	| { kind: "help" }
	| { kind: "tasks" }
	| { kind: "status" }
	| { kind: "start"; rows: number[] }
	| { kind: "screen"; row: number }
	| { kind: "done"; row: number }
	| { kind: "add"; text: string } {
	// "/tasks@OdinBot" is what a tap in a command menu sends.
	const word = text.replace(/^\/(\w+)(@\w+)?$/, "$1").toLowerCase();
	if (word === "help" || word === "?" || word === "start")
		return { kind: "help" };
	if (word === "tasks" || word === "backlog") return { kind: "tasks" };
	// A bare "/screen" from the command menu: the numbered list to pick from.
	if (["status", "sessions", "screen", "done"].includes(word))
		return { kind: "status" };
	const session = /^\/?(screen|done)\s+(\d+)$/i.exec(text);
	if (session?.[1] && session[2])
		return {
			kind: session[1].toLowerCase() as "screen" | "done",
			row: Number(session[2]),
		};
	const start = /^\/?start\s+([\d,\s]+)$/i.exec(text);
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
			lastPaneIds = sessions.map((session) => session.paneId);
			if (sessions.length === 0) return "No sessions on the board.";
			return sessions
				.map((session, i) => `${i + 1}. ${session.title}: ${session.status}`)
				.join("\n");
		}
		if (command.kind === "screen" || command.kind === "done") {
			const paneId = lastPaneIds[command.row - 1];
			if (!paneId) return `Send /status first, then ${command.kind} <number>.`;
			if (command.kind === "screen")
				return (await readScreen(paneId)) || "The screen is empty.";
			return (await askRenderer("done", { paneId })) ?? "Odin didn't answer.";
		}
		if (command.kind === "start") {
			const ids = command.rows
				.map((row) => lastTaskIds[row - 1])
				.filter((id): id is string => !!id);
			if (ids.length === 0) return "Send /tasks first, then start <number>.";
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
	if (!config?.owner || watched.size === 0 || !event.paneId) return;
	if (event.eventType !== "Stop" && event.eventType !== "Failed") return;
	const sessions = await board<Session[]>("sessions").catch(() => []);
	const session = sessions.find((s) => s.paneId === event.paneId);
	if (!session || !watched.has(session.title)) return;
	if (event.eventType === "Failed") {
		await reply(`"${session.title}" failed. Open it in Odin.`);
		return;
	}
	const sent = await reply(
		`"${session.title}" is waiting for you. Reply to this message to answer it.\n\n${await readScreen(session.paneId)}`,
	);
	if (sent) alertPanes.set(sent, session.paneId);
}
