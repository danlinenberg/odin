import { initTRPC, TRPCError } from "@trpc/server";
import { appState } from "main/lib/app-state";
import { readTranscript, writeBrief } from "main/lib/claude-sessions";
import { askRenderer } from "main/lib/notifications/server";
import { loadSessions } from "main/lib/tray";
import { getWorkspaceRuntimeRegistry } from "main/lib/workspace-runtime";
import stripAnsi from "strip-ansi";
import superjson from "superjson";
import { z } from "zod";

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

const paneInput = z.object({ paneId: z.string().min(1) });

const sessionOf = (paneId: string) =>
	appState.data.tabsState.panes?.[paneId]?.claudeSessionId;

/** Same as the board's typeIntoClaude: Enter only once Claude drew the text. */
async function typeIntoClaude(paneId: string, text: string) {
	const squash = (value: string) => value.replace(/\s+/g, "");
	const tail = squash(text).slice(-24);
	const drawn = async () =>
		squash((await terminal().readScreen({ paneId })) ?? "").split(tail).length -
		1;
	const before = await drawn();
	terminal().write({
		paneId,
		data: text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text,
	});
	// ponytail: 2s cap, then Enter anyway - same as the desktop reply box.
	for (let waited = 0; waited < 2000; waited += 50) {
		if ((await drawn()) > before) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	await new Promise((resolve) => setTimeout(resolve, 30));
	terminal().write({ paneId, data: "\r" });
}

export const phoneRouter = t.router({
	/** Running sessions (Needs you first) and the backlog not started yet. */
	board: t.procedure.query(async () => {
		const sessions = await loadSessions();
		const backlog = (
			JSON.parse(await board("tasks").catch(() => "[]")) as {
				id: string;
				title: string;
				started: boolean;
				repo?: string;
			}[]
		).filter((task) => !task.started);
		return { sessions, backlog };
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
			messages: transcript?.messages.slice(-60) ?? [],
			screen,
		};
	}),

	/** Separate from `session`: a brief that isn't cached runs `claude -p`. */
	brief: t.procedure.input(paneInput).query(async ({ input }) => {
		const sessionId = sessionOf(input.paneId);
		if (!sessionId) return null;
		const brief = await writeBrief({ sessionId }).catch(() => null);
		return brief ? (brief.done ?? brief.status ?? brief.goal) : null;
	}),

	reply: t.procedure
		.input(paneInput.extend({ text: z.string().min(1).max(20_000) }))
		.mutation(({ input }) => typeIntoClaude(input.paneId, input.text)),

	/** One raw key for a prompt Claude draws as a menu: Enter, Esc, a digit. */
	key: t.procedure
		.input(paneInput.extend({ key: z.enum(["enter", "esc", "1", "2", "3"]) }))
		.mutation(({ input }) => {
			const data = { enter: "\r", esc: "\x1b" }[input.key as "enter" | "esc"];
			terminal().write({ paneId: input.paneId, data: data ?? input.key });
		}),

	add: t.procedure
		.input(z.object({ text: z.string().min(1).max(20_000) }))
		.mutation(({ input }) => board("add", { text: input.text })),

	start: t.procedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(({ input }) => board("start", { ids: input.id })),

	done: t.procedure
		.input(paneInput)
		.mutation(({ input }) => board("done", { paneId: input.paneId })),
});

export type PhoneRouter = typeof phoneRouter;
