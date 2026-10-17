import { basename, resolve, sep } from "node:path";
import { initTRPC, TRPCError } from "@trpc/server";
import type { PullRequestStatus } from "lib/trpc/routers/terminal/pr-state";
import { appState } from "main/lib/app-state";
import { readTranscript, writeBrief } from "main/lib/claude-sessions";
import { askRenderer } from "main/lib/notifications/server";
import { appCaller } from "main/lib/odin-api";
import { loadSessions } from "main/lib/tray";
import { getWorkspaceRuntimeRegistry } from "main/lib/workspace-runtime";
import {
	claimOpened,
	jiraIssue,
	notionPage,
	prLabel,
	pullRequests,
	slackThread,
} from "renderer/routes/_authenticated/_odin/board/brief";
import stripAnsi from "strip-ansi";
import superjson from "superjson";
import { z } from "zod";
import { attachments } from "./attachments";

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
async function typeIntoClaude(paneId: string, text: string, paths: string[]) {
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
	if (text) write(text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text);
	// ponytail: 3s cap, then Enter anyway - a path Claude collapses never shows.
	const expected = paths.length + (text ? 1 : 0);
	await until(async () => (await drawn()) >= before + expected, 3000);
	await pause(30);
	write("\r");
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
		const sessions = await loadSessions(true);
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
		const transcript = sessionId
			? await readTranscript({ sessionId }).catch(() => null)
			: null;
		const screen = stripAnsi(
			(await terminal()
				.readScreen(input)
				.catch(() => null)) ?? "",
		)
			.split("\n")
			.map((line) => line.trimEnd())
			.filter(Boolean)
			.slice(-14)
			.join("\n");
		return {
			title: pane.odinTaskTitle ?? "Session",
			status: pane.status ?? "idle",
			starred: !!pane.odinStarred,
			messages: transcript?.messages.slice(-60) ?? [],
			screen,
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
		const brief = await writeBrief({ sessionId }).catch(() => null);
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
		// ponytail: the last 8 PRs; each one is a `gh pr view`.
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
				})
				.refine((input) => input.text.trim() || input.paths.length),
		)
		.mutation(({ input }) =>
			typeIntoClaude(input.paneId, input.text.trim(), input.paths),
		),

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

	start: t.procedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(({ input }) => board("start", { ids: input.id })),

	done: t.procedure
		.input(paneInput)
		.mutation(({ input }) => board("done", { paneId: input.paneId })),
});

export type PhoneRouter = typeof phoneRouter;
