import { basename, resolve, sep } from "node:path";
import { initTRPC, TRPCError } from "@trpc/server";
import { activeProfileId, listProfiles } from "lib/trpc/routers/odin-config";
import type { PullRequestStatus } from "lib/trpc/routers/terminal/pr-state";
import { appState } from "main/lib/app-state";
import {
	cachedBriefs,
	readTranscript,
	tailPrompt,
	tailTurn,
	transcriptTail,
} from "main/lib/claude-sessions";
import { askRenderer } from "main/lib/notifications/server";
import { appCaller } from "main/lib/odin-api";
import { loadSessions } from "main/lib/tray";
import { getWorkspaceRuntimeRegistry } from "main/lib/workspace-runtime";
import { NATIVE_API } from "renderer/mobile/native-api";
import {
	localCommand,
	runnableCommands,
} from "renderer/routes/_authenticated/_odin/board/action-items";
import {
	claimOpened,
	jiraIssue,
	notionPage,
	prLabel,
	pullRequests,
	slackThread,
} from "renderer/routes/_authenticated/_odin/board/brief";
import { parseScreenMenu } from "renderer/routes/_authenticated/_odin/board/screen-menu";
import { boardSection } from "shared/board-section";
import { withDismissalNote } from "shared/dismissed-match";
import { interruptClaude } from "shared/interrupt-claude";
import { boardTags } from "shared/odin-tags";
import stripAnsi from "strip-ansi";
import superjson from "superjson";
import { z } from "zod";
import { typedText } from "../../../shared/typed-text";
import { attachments } from "./attachments";
import { forSession } from "./host-files";
import { readScreens } from "./screens";
import { rememberFromPhone } from "./sent";

/**
 * Everything the phone can do, and nothing else: the LAN never reaches the
 * app's own router (window, filesystem, settings). Reads come from main; the
 * backlog belongs to the window, so those go through askRenderer like /odin.
 */
const t = initTRPC.create({ transformer: superjson });

const terminal = () => getWorkspaceRuntimeRegistry().getDefault().terminal;

/** The window owns the backlog - its answer, or a clear error when it's closed. */
async function board(action: string, args: Record<string, string> = {}) {
	const text = await askRenderer(action, args);
	if (text === undefined)
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Open Odin on your Mac.",
		});
	if (text === null)
		throw new TRPCError({ code: "TIMEOUT", message: "Odin didn't answer." });
	return text;
}

/** The window's Done shelf; [] from a window that doesn't know the action. */
async function doneShelf(): Promise<
	{
		key: string;
		title: string;
		source: string;
		url: string | null;
		at: number;
	}[]
> {
	try {
		return JSON.parse(await board("done-list"));
	} catch {
		return [];
	}
}

const paneInput = z.object({ paneId: z.string().min(1) });

const sessionOf = (paneId: string) =>
	appState.data.tabsState.panes?.[paneId]?.claudeSessionId;

const IMAGE_RE = /\.(png|jpe?g|gif|webp|heic)$/i;

/** An uploaded file's path, and only that: the phone can't paste any path. */
const attachment = z
	.string()
	.refine((path) => resolve(path).startsWith(`${attachments.dir}${sep}`));

/** Small JPEGs of pasted images, by the original's data URL: the phone polls. */
const thumbs = new Map<string, string>();
async function thumbnail(dataUrl: string): Promise<string> {
	const hit = thumbs.get(dataUrl);
	if (hit) return hit;
	const { nativeImage } = await import("electron");
	const image = nativeImage.createFromDataURL(dataUrl);
	const small =
		image.getSize().width > 480 ? image.resize({ width: 480 }) : image;
	const thumb = `data:image/jpeg;base64,${small.toJPEG(70).toString("base64")}`;
	// Cleared at 200: a session rarely shows that many.
	if (thumbs.size > 200) thumbs.clear();
	thumbs.set(dataUrl, thumb);
	return thumb;
}

/** Enter, Tab, Esc and the arrows: what a menu takes besides numbers. */
const MENU_KEYS = new Set(["\r", "\t", "\x1b", "\x1b[A", "\x1b[B"]);

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** How often the text's last characters show on Claude's screen. */
async function drawCount(paneId: string, text: string): Promise<number> {
	const squash = (value: string) => value.replace(/\s+/g, "");
	const tail = squash(text).slice(-24);
	const screen = (await terminal().readScreen({ paneId })) ?? "";
	return tail ? squash(screen).split(tail).length - 1 : 0;
}

async function until(done: () => Promise<boolean>, capMs: number) {
	for (let waited = 0; waited < capMs && !(await done()); waited += 50)
		await pause(50);
}

/**
 * The board's composer, from the phone: files first (a bracketed paste of
 * each path, which Claude turns into [Image #N]), then the text, and Enter
 * only once Claude drew them - text and Enter in one read is taken as a paste
 * and sits in the input box.
 */
async function typeIntoClaude(
	paneId: string,
	text: string,
	paths: string[],
	now = false,
) {
	const write = (data: string) => terminal().write({ paneId, data });
	const marks = [
		...new Set(paths.map((path) => (IMAGE_RE.test(path) ? "[Image #" : path))),
		...(text ? [text] : []),
	];
	const drawn = async () => {
		let count = 0;
		for (const mark of marks) count += await drawCount(paneId, mark);
		return count;
	};
	const before = await drawn();
	for (const path of paths) write(`\x1b[200~${path}\x1b[201~ `);
	if (text) write(typedText(text));
	const expected = paths.length + (text ? 1 : 0);
	await until(async () => (await drawn()) >= before + expected, 3000);
	await pause(30);
	// Ctrl+X Ctrl+S, the board's Send now: lands mid-turn, not after it.
	write(now ? "\x18\x13" : "\r");
}

/** The remote host's copy of a message's files, from the board's own procedure. */
async function filesToHost(message: {
	text: string;
	paths: string[];
}): Promise<{ text: string; paths: string[] }> {
	// The app router is untyped from here; filesToHost answers the rewritten message.
	const caller = appCaller() as
		| {
				remoteHost: {
					filesToHost: (input: {
						text: string;
						paths: string[];
					}) => Promise<{ text: string; paths: string[] }>;
				};
		  }
		| undefined;
	if (!caller) throw new Error("Odin is still starting");
	return caller.remoteHost.filesToHost(message);
}

/** A task's notes point at its files the way the desktop Tasks editor does. */
const ATTACHMENT_URL = "odin-attachment://file/";
const taskWithFiles = (text: string, paths: string[]) =>
	[
		text.trim() || "From my phone",
		...paths.map((path) => {
			const name = basename(path);
			return IMAGE_RE.test(path)
				? `![](${ATTACHMENT_URL}${name})`
				: `[${name}](${ATTACHMENT_URL}${name})`;
		}),
	].join("\n\n");

export const phoneRouter = t.router({
	/** Running sessions (Needs you first) and the backlog not started yet. */
	board: t.procedure.query(async () => {
		// The profile Odin is in, as the desktop board shows it.
		const sessions = await loadSessions(true, activeProfileId());
		const backlog = (
			JSON.parse(await board("tasks").catch(() => "[]")) as {
				id: string;
				title: string;
				started: boolean;
				repo?: string;
			}[]
		).filter((task) => !task.started);
		return { sessions, backlog, done: await doneShelf() };
	}),

	/** The conversation, prose only, plus the brief's TL;DR when one is cached or quick. */
	session: t.procedure.input(paneInput).query(async ({ input }) => {
		const pane = appState.data.tabsState.panes?.[input.paneId];
		if (!pane) throw new TRPCError({ code: "NOT_FOUND" });
		const sessionId = sessionOf(input.paneId);
		// The log's end only: a long session's log runs to tens of MB.
		const tail = sessionId
			? await transcriptTail({ sessionId }).catch(() => [])
			: [];
		const messages = await Promise.all(
			tail.map(async (message) =>
				message.images
					? {
							...message,
							images: await Promise.all(message.images.map(thumbnail)),
						}
					: message,
			),
		);
		const fullScreen = stripAnsi(
			(await terminal()
				.readScreen(input)
				.catch(() => null)) ?? "",
		);
		// What the board's chat answers in cards: Claude's question or plan,
		// else a menu the terminal draws (folder trust, the usage limit menu).
		const prompt = sessionId ? tailPrompt(sessionId) : null;
		const menu = prompt ? null : parseScreenMenu(fullScreen);
		const screen = fullScreen
			.split("\n")
			.map((line) => line.trimEnd())
			.filter(Boolean)
			.slice(-14)
			.join("\n");
		return {
			title: pane.odinTaskTitle ?? "Session",
			status: pane.status ?? "idle",
			starred: !!pane.odinStarred,
			// What the board card shows: who it's for, where it runs, its tags.
			details: {
				contact: pane.odinContact ?? null,
				source: boardSection(pane),
				remote: pane.odinRemote ?? null,
				// The ssh session to the host is this pane's terminal.
				connected: await terminal()
					.management.listSessions()
					.then(({ sessions }) =>
						sessions.some((s) => s.sessionId === input.paneId && s.isAlive),
					)
					.catch(() => undefined),
				tags: boardTags(pane.odinTags),
				repo:
					(pane.cwd ?? pane.initialCwd)?.split("/").filter(Boolean).pop() ??
					null,
			},
			messages,
			screen,
			prompt,
			menu,
			// What Claude ran since your last message, for the Working line.
			turn: sessionId ? tailTurn(sessionId) : null,
		};
	}),

	/**
	 * The session's written brief: the TL;DR line and, for the card opened in
	 * full, its goal, what it did, where it stands and what's next; plus the
	 * latest reply's TL;DR (`last`), as the board's chat leads it. Separate
	 * from `session`: a brief that isn't cached runs `claude -p`.
	 */
	brief: t.procedure.input(paneInput).query(async ({ input }) => {
		const sessionId = sessionOf(input.paneId);
		if (!sessionId) return null;
		// Only the one already written: writing one runs `claude -p` for
		// seconds, and Odin on the Mac writes them as the board shows them.
		const brief = (await cachedBriefs().catch(() => null))?.get(sessionId);
		if (!brief) return null;
		const { goal, done, status, next, last, urgency, replyAt } = brief;
		return {
			tldr: done ?? status ?? goal,
			goal,
			done,
			status,
			next,
			// The latest reply's own TL;DR, and which reply it describes.
			last,
			urgency,
			replyAt: replyAt ?? null,
		};
	}),

	/**
	 * What the session's brief links to, live: its PRs with their state and
	 * CI, its Jira ticket's status, its Slack thread and Notion page - found
	 * in the transcript the way the desktop's session brief finds them.
	 */
	links: t.procedure.input(paneInput).query(async ({ input }) => {
		const sessionId = sessionOf(input.paneId);
		const transcript = sessionId
			? await readTranscript({ sessionId }).catch(() => null)
			: null;
		const source = transcript ? (transcript.links ?? transcript.messages) : [];
		const prs = pullRequests(source).slice(-8);
		const issue = jiraIssue(source);
		// The app router is untyped from here; these are its answers' shapes.
		const caller = appCaller() as
			| {
					terminal: {
						pullRequestStates: (input: {
							urls: string[];
						}) => Promise<Record<string, PullRequestStatus | null>>;
					};
					work: {
						jiraIssueStates: (input: {
							keys: string[];
						}) => Promise<Record<string, { status: string }>>;
					};
			  }
			| undefined;
		const [states, jira] = await Promise.all([
			prs.length && caller
				? caller.terminal
						.pullRequestStates({ urls: prs.map((pr) => pr.url) })
						.then((found) => claimOpened(source, found))
						.catch(() => ({}))
				: {},
			issue && caller
				? caller.work.jiraIssueStates({ keys: [issue.key] }).catch(() => ({}))
				: {},
		]);
		const state = (url: string) =>
			(states as Record<string, PullRequestStatus | null>)[url] ?? null;
		return {
			prs: prs.map((pr) => ({
				url: pr.url,
				label: prLabel(pr, state(pr.url)?.title),
				status: state(pr.url),
			})),
			jira: issue && {
				...issue,
				status:
					(jira as Record<string, { status: string }>)[issue.key]?.status ??
					null,
			},
			slack: slackThread(source),
			notion: notionPage(source),
		};
	}),

	/** The checkouts a new task can run in - New task's repo picker. */
	repos: t.procedure.query(async () => {
		// The app router is untyped from here; repos.list answers sorted paths.
		const caller = appCaller() as
			| { repos: { list: () => Promise<string[]> } }
			| undefined;
		return (await caller?.repos.list()) ?? [];
	}),

	/** Star or unstar a session; the window owns pane state, so it goes there. */
	star: t.procedure
		.input(paneInput.extend({ starred: z.boolean() }))
		.mutation(({ input }) =>
			board("star", {
				paneId: input.paneId,
				starred: String(input.starred),
			}),
		),

	reply: t.procedure
		.input(
			paneInput
				.extend({
					text: z.string().max(20_000),
					paths: z.array(attachment).max(10).default([]),
					/** Claude reads it mid-turn instead of once the turn ends. */
					now: z.boolean().default(false),
				})
				.refine((input) => input.text.trim() || input.paths.length),
		)
		.mutation(async ({ input }) => {
			const sent = await forSession(
				appState.data.tabsState.panes?.[input.paneId],
				{ text: input.text.trim(), paths: input.paths },
				(message) => filesToHost(message),
			);
			// As a reply from the board: it carries the items you dismissed since.
			const untold: string[] = await board("dismissed", {
				paneId: input.paneId,
				take: "true",
			})
				.then((answer) => JSON.parse(answer).untold ?? [])
				.catch(() => []);
			const text = withDismissalNote(sent.text, untold);
			// Claude has exited that session: the board resumes it with the reply,
			// files named on their own lines, as its chat box does.
			const opening = [...sent.paths, text].filter(Boolean).join("\n");
			const answer = await askRenderer("phone-reply", {
				paneId: input.paneId,
				text: opening,
			}).catch(() => null);
			// "delivered": a remote session the board types into once the host is back.
			if (answer !== "resumed" && answer !== "delivered")
				await typeIntoClaude(input.paneId, text, sent.paths, input.now);
			rememberFromPhone(input.paneId, input.text);
		}),

	/** The action items you dismissed in this session, as the board hides them. */
	dismissed: t.procedure.input(paneInput).query(async ({ input }) => {
		const answer = await board("dismissed", { paneId: input.paneId }).catch(
			() => null,
		);
		return answer ? (JSON.parse(answer).items as string[]) : [];
	}),

	/** The board's X on an action item: hidden from now on, and Claude is told. */
	dismiss: t.procedure
		.input(paneInput.extend({ item: z.string().min(1).max(4_000) }))
		.mutation(({ input }) =>
			board("dismiss-item", { paneId: input.paneId, item: input.item }),
		),

	/**
	 * Every session's conversation, searched as Session History does (the
	 * desktop's ⌘F): titles, prompts and what was said. A session on the board
	 * comes with its paneId, which the phone opens.
	 */
	search: t.procedure
		.input(z.object({ query: z.string().trim().min(2).max(200) }))
		.query(async ({ input }) => {
			const { searchSessions } = await import("main/lib/claude-sessions");
			const { cardTitles } = await import("main/lib/card-titles");
			const { sessionPeople } = await import(
				"lib/trpc/routers/terminal/session-people"
			);
			const panes = Object.values(appState.data.tabsState.panes ?? {});
			const titles: Record<string, string> = {};
			for (const [id, brief] of await cachedBriefs())
				if (brief.title) titles[id] = brief.title;
			// The name its card has on the board: what you'd type to find it.
			for (const pane of panes)
				if (pane.claudeSessionId && pane.odinTaskTitle)
					titles[pane.claudeSessionId] = pane.odinTaskTitle;
			Object.assign(titles, cardTitles());
			const { sessions } = await searchSessions({
				query: input.query,
				limit: 30,
				people: sessionPeople(),
				titles,
			});
			// The board's column for a session on it, as its card shows it.
			const columns = new Map(
				(await loadSessions(true, activeProfileId())).map((row) => [
					row.paneId,
					row.column,
				]),
			);
			return (
				sessions
					.map((session) => {
						const paneId =
							panes.find((pane) => pane.claudeSessionId === session.sessionId)
								?.id ?? null;
						return {
							sessionId: session.sessionId,
							paneId,
							title: session.title,
							snippet: session.snippets[0]?.text ?? session.prompt ?? "",
							person: session.person,
							updatedAt: session.updatedAt,
							status: (paneId && columns.get(paneId)) || null,
						};
					})
					// Last activity first: the session you were just in is the one you want.
					.sort((a, b) => b.updatedAt - a.updatedAt)
			);
		}),

	/** The board's Stop: Ctrl+C the turn, never at an idle prompt. */
	interrupt: t.procedure.input(paneInput).mutation(async ({ input }) => {
		const sent = await interruptClaude(
			async (keys) => terminal().write(keys),
			async (pane) => ({
				text: (await terminal().readScreen(pane)) ?? null,
			}),
			input.paneId,
		);
		// Claude fires no Stop hook on an interrupt: the card says so now.
		await askRenderer("interrupted", {
			paneId: input.paneId,
			sent: String(sent),
		}).catch(() => null);
		return { sent };
	}),

	/**
	 * A `!` block's Run button: in Claude's session (its output goes back to
	 * Claude), or a `!local` one in the session's Shell on this Mac. Only a
	 * command Claude's latest reply hands you: the phone can't run its own.
	 */
	run: t.procedure
		.input(paneInput.extend({ command: z.string().min(1).max(8_000) }))
		.mutation(async ({ input }) => {
			const sessionId = sessionOf(input.paneId);
			const tail = sessionId
				? await transcriptTail({ sessionId }).catch(() => [])
				: [];
			if (!runnableCommands(tail).includes(input.command))
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "That command isn't in Claude's latest reply.",
				});
			const local = localCommand(input.command);
			if (local) {
				await board("run-local", { paneId: input.paneId, command: local });
				return;
			}
			// As the board's Run: `!` puts Claude in bash mode, then the command.
			terminal().write({ paneId: input.paneId, data: "!" });
			await pause(50);
			await typeIntoClaude(input.paneId, input.command, []);
		}),

	/**
	 * The keys a question, plan or menu card answers with, as the board's
	 * sendKeys writes them: a number, an arrow, Tab, Enter, Esc, or a line of
	 * typed text - no other control keys.
	 */
	keys: t.procedure
		.input(
			paneInput.extend({
				keys: z
					.array(
						z
							.string()
							.min(1)
							.max(4_000)
							.refine(
								(key) =>
									MENU_KEYS.has(key) ||
									/^\d{1,2}$/.test(key) ||
									// biome-ignore lint/suspicious/noControlCharactersInRegex: typed text has none
									!/[\x00-\x1f\x7f]/.test(key),
							),
					)
					.min(1)
					.max(60),
			}),
		)
		.mutation(async ({ input }) => {
			for (const key of input.keys) {
				terminal().write({ paneId: input.paneId, data: key });
				await pause(250);
			}
		}),

	/**
	 * Newer screens for the phone to run (renderer/mobile/boot.ts): Odin's
	 * own build, when the phone's native side is the one they were built for
	 * and it doesn't run them already. Null otherwise.
	 */
	screens: t.procedure
		.input(
			z.object({
				/** The version the phone runs; "built-in" for its app's own. */
				have: z.string().max(100),
				/** The phone app's NATIVE_API. */
				native: z.number().int(),
			}),
		)
		.query(async ({ input }) => {
			if (input.native !== NATIVE_API) return null;
			const screens = await readScreens();
			if (!screens || screens.version === input.have) return null;
			return { ...screens, native: NATIVE_API };
		}),

	/** One raw key for a prompt Claude draws as a menu: Enter, Esc, a digit. */
	key: t.procedure
		.input(paneInput.extend({ key: z.enum(["enter", "esc", "1", "2", "3"]) }))
		.mutation(({ input }) => {
			const data = { enter: "\r", esc: "\x1b" }[input.key as "enter" | "esc"];
			terminal().write({ paneId: input.paneId, data: data ?? input.key });
		}),

	add: t.procedure
		.input(
			z
				.object({
					text: z.string().max(20_000),
					paths: z.array(attachment).max(10).default([]),
					/** A checkout from `repos`; none = the default the window picks. */
					repo: z.string().optional(),
					/** Start it on the board now, not just save it to the backlog. */
					start: z.boolean().default(false),
				})
				.refine((input) => input.text.trim() || input.paths.length),
		)
		.mutation(({ input }) =>
			board("add", {
				text: taskWithFiles(input.text, input.paths),
				...(input.repo && { repo: input.repo }),
				...(input.start && { start: "true" }),
			}),
		),

	/** Odin's profiles, and the one it's in. */
	profiles: t.procedure.query(() => ({
		activeId: activeProfileId(),
		profiles: listProfiles().map(({ id, name }) => ({ id, name })),
	})),

	/** Switches Odin's profile, as the desktop's profile menu does. */
	setProfile: t.procedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(async ({ input }) => {
			if (!listProfiles().some((profile) => profile.id === input.id))
				throw new Error("No such profile");
			await board("profile", { id: input.id });
			// The window's switch is a round trip of its own: answer once it landed.
			for (let i = 0; i < 40 && activeProfileId() !== input.id; i++)
				await new Promise((resolve) => setTimeout(resolve, 50));
		}),

	start: t.procedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(({ input }) => board("start", { ids: input.id })),

	done: t.procedure
		.input(paneInput)
		.mutation(({ input }) => board("done", { paneId: input.paneId })),

	/** Remind me: off the board now, back on `day` (YYYY-MM-DD), as the board's bell. */
	remind: t.procedure
		.input(paneInput.extend({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
		.mutation(({ input }) =>
			board("remind", { paneId: input.paneId, day: input.day }),
		),
});

export type PhoneRouter = typeof phoneRouter;
