import { execFile } from "node:child_process";
import { initTRPC, TRPCError } from "@trpc/server";
import { hostReplyScript } from "main/lib/remote-host/session";
import { parseScreenMenu } from "renderer/routes/_authenticated/_odin/board/screen-menu";
import superjson from "superjson";
import { z } from "zod";
import {
	tailPrompt,
	tailTurn,
	transcriptTail,
} from "../../claude-sessions/claude-sessions";
import {
	findSession,
	type HostSession,
	hostPaths,
	hostSessions,
	hostStatus,
	readScreen,
	readSnapshot,
} from "./sessions";

/**
 * What the phone server on a remote host answers (phone-host): the sessions
 * running here, their conversations, and a reply typed into one - the part
 * of the phone's API (../router.ts) that needs nothing but this host, so it
 * works with the laptop shut. The names and shapes are the laptop's, so the
 * phone reads either. Each answer says it came from the host (`via`).
 */
const t = initTRPC.create({ transformer: superjson });

const paneInput = z.object({ paneId: z.string().min(1) });

/** The host's name, as the phone shows it. */
const hostName = () => readSnapshot().host || "the remote host";

/** Runs a shell script as this user; resolves with its exit code. */
export const shell = {
	run: (script: string): Promise<number> =>
		new Promise((resolve) => {
			execFile("bash", ["-c", script], { timeout: 30_000 }, (error) =>
				resolve(error ? (typeof error.code === "number" ? error.code : 1) : 0),
			);
		}),
};

const tail = (sessionId: string) =>
	transcriptTail({ sessionId, root: hostPaths.projects }).catch(() => []);

/** A title for a session the laptop's board never showed this host: its first words. */
async function titleOf(session: HostSession): Promise<string> {
	if (session.card?.title) return session.card.title;
	const first = (await tail(session.sessionId)).find((m) => m.role === "user");
	const words = first?.text.replace(/\s+/g, " ").trim() ?? "";
	return words ? words.slice(0, 80) : "Session on the remote host";
}

async function statusOf(session: HostSession) {
	const screen = await readScreen(session.tmux);
	return {
		screen,
		status: hostStatus(screen, session.claude, session.card?.column),
	};
}

async function sessionOrThrow(paneId: string) {
	const session = await findSession(paneId);
	if (!session)
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "That session isn't running on the remote host.",
		});
	return session;
}

export const hostPhoneRouter = t.router({
	/** The sessions running here, as board rows. No backlog: that lives on the laptop. */
	board: t.procedure.query(async () => {
		const sessions = await Promise.all(
			(await hostSessions()).map(async (session) => {
				const { status } = await statusOf(session);
				const card = session.card;
				return {
					paneId: session.paneId,
					title: await titleOf(session),
					source: card?.source ?? "other",
					column: status,
					contact: card?.contact ?? null,
					tags: card?.tags ?? [],
					remote: card?.remote ?? hostName(),
					connected: true,
					repo: card?.repo ?? null,
					starred: card?.starred ?? false,
					statusAt: card?.statusAt ?? null,
					night: card?.night,
				};
			}),
		);
		return {
			sessions,
			backlog: [] as { id: string; title: string; started: boolean }[],
			done: [] as {
				key: string;
				title: string;
				source: string;
				url: string | null;
				at: number;
			}[],
			via: { host: hostName() },
		};
	}),

	/** The conversation, its screen, and what it asks: as the laptop's `session`. */
	session: t.procedure.input(paneInput).query(async ({ input }) => {
		const session = await sessionOrThrow(input.paneId);
		// The laptop shrinks pasted images first; here they stay out.
		const messages = (await tail(session.sessionId)).map(
			({ images: _images, ...message }) => message,
		);
		const { screen: fullScreen, status } = await statusOf(session);
		const prompt = tailPrompt(session.sessionId);
		const card = session.card;
		return {
			title: await titleOf(session),
			status,
			starred: card?.starred ?? false,
			details: {
				contact: card?.contact ?? null,
				source: card?.source ?? "other",
				remote: card?.remote ?? hostName(),
				connected: true,
				tags: card?.tags ?? [],
				repo: card?.repo ?? null,
			},
			messages,
			screen: fullScreen
				.split("\n")
				.map((line) => line.trimEnd())
				.filter(Boolean)
				.slice(-14)
				.join("\n"),
			prompt,
			menu: prompt ? null : parseScreenMenu(fullScreen),
			turn: tailTurn(session.sessionId),
			via: { host: hostName() },
		};
	}),

	/**
	 * A reply, typed into the session's Claude here as the laptop types a
	 * board reply into a host session. Text only: the phone's files go to
	 * the laptop.
	 */
	reply: t.procedure
		.input(
			paneInput.extend({
				text: z.string().max(20_000),
				paths: z.array(z.string()).max(10).default([]),
				now: z.boolean().default(false),
			}),
		)
		.mutation(async ({ input }) => {
			if (input.paths.length)
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						"Files go through your Mac, which is asleep. Send the text alone, or send them once it's back.",
				});
			const text = input.text.trim();
			if (!text) throw new TRPCError({ code: "BAD_REQUEST" });
			const session = await sessionOrThrow(input.paneId);
			const code = await shell.run(
				hostReplyScript(session.sessionId, text, input.now),
			);
			if (code === 3)
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						"This session ended on the remote host. Open Odin on your Mac to resume it.",
				});
			if (code !== 0)
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "The remote host couldn't type it in.",
				});
			return { via: { host: hostName() } };
		}),

	/** The laptop writes briefs and reads links; with it away, there are none. */
	brief: t.procedure.input(paneInput).query(() => null),
	links: t.procedure.input(paneInput).query(() => ({
		prs: [],
		jira: null,
		slack: null,
		notion: null,
	})),
	dismissed: t.procedure.input(paneInput).query((): string[] => []),
	/**
	 * Asked beside the board and on New task, in one batch with what the host
	 * answers: empty here, so the batch still gets its answer with the Mac away.
	 */
	profiles: t.procedure.query(() => ({
		activeId: "",
		profiles: [] as { id: string; name: string }[],
	})),
	host: t.procedure.query(() => null),
	repos: t.procedure.query((): string[] => []),
	screens: t.procedure
		.input(z.object({ have: z.string().max(100), native: z.number().int() }))
		.query(() => null),
});

export type HostPhoneRouter = typeof hostPhoneRouter;
