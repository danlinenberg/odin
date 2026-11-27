import { toast } from "@odin/ui/sonner";
import { useNavigate } from "@tanstack/react-router";
import { useLaunchTaskSession } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import {
	askSessionContext,
	type SessionContext,
} from "../components/SessionContextDialog";
import { ATTACHMENT_URL, useMyTasks } from "../hooks/useOdinTasks";
import { useOdinWorkspace } from "../hooks/useOdinWorkspace";
import { usePaneMeta } from "../hooks/usePaneMeta";
import { usePendingFocus } from "../hooks/usePendingFocus";
import { type AllItem, livePanesOn, paneMatchRule } from "./all-items";
import { useTaskMeta } from "./task-meta";

/** Hover text on Start / Start task, in the panel and on a row. */
export const START_SESSION_TIP =
	"Start a Claude session on this task: pick where it runs, then it opens on the Dev Board with the task (and your notes) as its brief. The session stays linked to the task, so this button turns into Open on board while it runs.";

/** Hover text on Start another session, on a row or in the panel. */
export const START_ANOTHER_TIP =
	"Start another session on this task - it stays linked too, and Open on board opens the newest";

export { paneWorksOn } from "./all-items";

/** What starting a row came to: the session, or why there is none. */
export type StartResult =
	| { ok: true; paneId: string; sessionId: string }
	| { ok: false; error: string };

/**
 * Start a session on an All row, from wherever the row is shown - the All
 * feed, or the board's Next in line. `onSlackStarted` refetches whatever
 * list the Slack row should now leave.
 */
/**
 * Your notes on a Slack, Jira or other row, for its session; your own tasks'
 * notes are already their brief (launch.description).
 */
function myNotes(item: AllItem): string | null {
	const note = useTaskMeta.getState().notes[item.key];
	return note
		? `My notes:\n${note.replaceAll(ATTACHMENT_URL, "~/.odin/attachments/")}`
		: null;
}

export function useStartAllItem(onSlackStarted?: () => void) {
	const navigate = useNavigate();
	const { ensureWorkspace } = useOdinWorkspace();
	const { launch, planForHost, isLaunching, launchingKey } =
		useLaunchTaskSession();
	const { setPane } = useMyTasks();
	const panes = useTabsStore((s) => s.panes);
	// Starting a Slack row is what takes it out of the queue - the same call
	// the Slack feed makes, so a message started here doesn't come back.
	const markStarted = electronTrpc.slack.markStarted.useMutation({
		onSuccess: () => onSlackStarted?.(),
	});

	/**
	 * The pane already working this row, if there is one. Panes carry the page
	 * id for Slack/Notion and the launch title for everything else - matching
	 * both is what keeps Start task from opening a second agent on a ticket
	 * that already has one. The brief too: it's written once at launch, while
	 * the title gets auto-retitled and a session started from the Notion mirror
	 * of a Slack message carries the Notion page id, not the Slack one.
	 */
	const livePanesFor = (item: AllItem): string[] =>
		livePanesOn(Object.values(panes), item).map((pane) => pane.id);
	/** The newest of them - where Open on board goes. */
	const livePaneFor = (item: AllItem): string | null =>
		livePanesFor(item)[0] ?? null;
	/**
	 * Open on board writes which sessions matched this row, and by which rule,
	 * to ~/.odin/session-match.log - for a row that opens another task's session.
	 */
	const logLivePanes = (item: AllItem): void => {
		const cut = (s?: string) => s?.slice(0, 80);
		console.info(
			`[session-match] ${JSON.stringify({
				row: item.key,
				title: cut(item.launch.title),
				brief: cut(item.launch.brief),
				pageId: item.launch.pageId,
				source: item.launch.source,
				paneIds: item.paneIds,
				matches: livePanesOn(Object.values(panes), item).map((pane) => ({
					id: pane.id,
					rule: paneMatchRule(pane, item),
					pageId: pane.odinPageId,
					source: pane.odinSource,
					title: cut(pane.odinTaskTitle),
					brief: cut(pane.odinBrief),
				})),
			})}`,
		);
	};

	/**
	 * `offHours` is the overnight runner's launch: tagged, told nobody is
	 * watching, handed the night's instructions - and it stays where you are
	 * instead of pulling the board into view. With `hostSession`, the session
	 * already runs on the remote host (the Night Agent started it there): the
	 * card attaches to it rather than starting one. `away` marks a session the
	 * phone started there with the Mac closed: not the Night Agent's, so no
	 * off-hours tag (the moon pill).
	 */
	const start = async (
		item: AllItem,
		offHours?: { instructions: string; hostSession?: string; away?: boolean },
		// Tags ride along to the launch: Auto-start marks its cards.
		picked?: SessionContext & { tags?: string[] },
	): Promise<StartResult> => {
		// Nobody is there to answer at night. A bulk start asked once already.
		const context =
			picked ?? (offHours ? {} : await askSessionContext(item.launch.title));
		if (!context) return { ok: false, error: "Cancelled" };
		const ensured = await ensureWorkspace();
		if (!ensured.ok) {
			toast.error(ensured.error);
			return { ok: false, error: ensured.error };
		}
		const description = [
			item.launch.description,
			myNotes(item),
			offHours?.instructions,
		]
			.filter(Boolean)
			.join("\n\n");
		const result = await launch({
			...item.launch,
			...context,
			description: description || null,
			workspaceId: ensured.workspace.id,
			...(offHours && !offHours.away ? { tags: ["off-hours"] } : {}),
			...(offHours?.hostSession
				? { resumeSessionId: offHours.hostSession, onHost: true }
				: {}),
		});
		if (!result.ok) {
			toast.error(result.error);
			return { ok: false, error: result.error };
		}
		if (item.source === "Slack") {
			markStarted.mutate({ id: item.launch.key });
			usePaneMeta.getState().setTitle(result.paneId, item.launch.title);
			usePaneMeta.getState().setSessionId(result.paneId, result.sessionId);
			usePaneMeta.getState().setPaneForPage(item.launch.key, result.paneId);
		}
		// My own tasks keep their row and gain a way into the session.
		if (item.source === "Tasks") setPane(item.launch.key, result.paneId);
		const started = {
			ok: true as const,
			paneId: result.paneId,
			sessionId: result.sessionId,
		};
		if (offHours || picked) return started;
		usePendingFocus.getState().focus(result.paneId);
		navigate({ to: "/board" });
		return started;
	};

	/**
	 * Start every row at once: one ask - context, and here or on the remote
	 * host - for the lot, then a session per row. Rows that already have a
	 * live session are skipped. Launches run one after another; the launch
	 * gates hold the extras in Idle until the Mac or host has room. False
	 * when the ask was cancelled.
	 */
	const startMany = async (items: AllItem[]): Promise<boolean> => {
		const todo = items.filter((item) => !livePaneFor(item));
		if (todo.length === 0) {
			toast.info("Each of these already has a session");
			return true;
		}
		const context = await askSessionContext(
			todo.length === 1
				? todo[0].launch.title
				: `${todo.length} tasks, one session each`,
		);
		if (!context) return false;
		let ok = 0;
		let first: string | null = null;
		for (const item of todo) {
			const result = await start(item, undefined, context);
			if (!result.ok) continue;
			ok += 1;
			first ??= result.paneId;
		}
		const skipped = items.length - todo.length;
		const failed = todo.length - ok;
		toast.success(
			[
				`Started ${ok} ${ok === 1 ? "session" : "sessions"}`,
				skipped ? `${skipped} already running` : "",
				failed ? `${failed} failed` : "",
			]
				.filter(Boolean)
				.join(" - "),
		);
		if (first) {
			usePendingFocus.getState().focus(first);
			navigate({ to: "/board" });
		}
		return true;
	};

	/**
	 * A launch of this row built for the remote host and not started: the
	 * Night Agent's, or with `away` the phone's Start with the Mac closed,
	 * which someone is watching (no off-hours tag or unattended wording).
	 */
	const planOnHost = async (
		item: AllItem,
		instructions: string,
		away = false,
	) => {
		const ensured = await ensureWorkspace();
		if (!ensured.ok) throw new Error(ensured.error);
		const plan = await planForHost({
			...item.launch,
			description:
				[item.launch.description, myNotes(item), instructions]
					.filter(Boolean)
					.join("\n\n") || null,
			workspaceId: ensured.workspace.id,
			tags: away ? [] : ["off-hours"],
		});
		// Feed rows name no repo: on the host the agent picks one from the list.
		return { ...plan, repoPath: null };
	};

	return {
		start,
		startMany,
		planOnHost,
		livePaneFor,
		logLivePanes,
		livePanesFor,
		isLaunching,
		launchingKey,
	};
}
