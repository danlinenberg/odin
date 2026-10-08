import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import * as terminalCache from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane, PaneStatus, Tab } from "renderer/stores/tabs/types";
import { lastAgentHookAt } from "renderer/stores/tabs/useAgentHookListener";
import { boardColumn, mergeStateColumn } from "shared/board-column";
import { profileOf } from "shared/odin-profile";
import {
	agentOnScreen,
	odinScreenStatus,
	odinScreenWrite,
} from "shared/odin-screen-status";
import type { BriefMessage } from "../board/brief";
import {
	ciRunning,
	mergeCheckUrls,
	mergeReady,
	onlyLookLeft,
	prsDropped,
	reviewEnded,
	reviewedPullRequest,
} from "../board/brief";
import { uniqueQueries } from "./unique-queries";
import { usePaneMeta } from "./usePaneMeta";

/**
 * How long a pane's agent hooks have to stay silent before screen-reading is
 * allowed to overrule them. Long enough that an active turn is left alone
 * entirely, short enough that a card stranded by a lost hook is corrected while
 * you're still looking at it.
 *
 * Two minutes rather than the twenty seconds this used to be: a healthy turn
 * goes quiet for as long as its longest single tool call, and measured against
 * real sessions that is over a minute - a test run, a subagent, a big search.
 * Every one of those gaps handed a mid-turn card to the scan below.
 */
const SETTLED_MS = 120_000;

// Built via string escapes - ANSI sequences are control chars by definition
export const ANSI_RE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
	/\x1b\[[0-9;?<>]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]|[\x00-\x08\x0b-\x1f]/g;

/**
 * Which column each board session's card sits in, and everything that decides
 * it beyond the pane's own status: the daemon poll, the screen scan that
 * catches a lost hook or a PTY with no Claude left in it, `/loop` sessions,
 * and the PR states that move a card to Working (CI running) or Done (only a
 * merge left). The Dev Board and Home both read their columns from here, so
 * the two can't disagree. The scan writes pane statuses, so it runs while
 * either is mounted.
 */
export function useBoardColumns({
	panes,
	tabs,
	titleByPane,
	activeProfileId,
}: {
	panes: Record<string, Pane>;
	tabs: Tab[];
	titleByPane: Record<string, string>;
	activeProfileId: string;
}) {
	const utils = electronTrpc.useUtils();
	// ponytail: in-memory "in this status since" per pane; resets on reload
	const statusSinceRef = useRef(
		new Map<string, { status: PaneStatus; at: number }>(),
	);
	// Statuses already on the panes when the board mounted came off disk: the
	// hooks that wrote them belong to a previous run of the renderer, so they've
	// been held for an unknown time, not for zero seconds. Stamp those "settled"
	// (at: 0) so the screen scan may correct a restored status on its first pass
	// rather than waiting out SETTLED_MS for a hook race that can't happen yet.
	// Panes that appear later are freshly launched and do get the full grace.
	const restoredRef = useRef(true);
	useEffect(() => {
		const map = statusSinceRef.current;
		const restored = restoredRef.current;
		restoredRef.current = false;
		for (const pane of Object.values(panes)) {
			const status = pane.status ?? "idle";
			const entry = map.get(pane.id);
			if (!entry || entry.status !== status) {
				map.set(pane.id, { status, at: restored ? 0 : Date.now() });
			}
		}
	}, [panes]);

	// A parked session that started moving again isn't parked any more - drop the
	// flag so its next finished turn lands in Needs you, not back in Idle.
	useEffect(() => {
		const revived = Object.values(panes).filter(
			(pane) => pane.odinParked && (pane.status ?? "idle") !== "idle",
		);
		if (revived.length === 0) return;
		useTabsStore.setState((state) => {
			const next = { ...state.panes };
			for (const pane of revived)
				next[pane.id] = { ...next[pane.id], odinParked: false };
			return { panes: next };
		});
	}, [panes]);

	// Live PTYs in the daemon - lets the board show sessions that survived an
	// app reload even though their pane status was reset to idle.
	const { data: daemonSessions } =
		electronTrpc.terminal.listDaemonSessions.useQuery(undefined, {
			refetchInterval: 5_000,
		});
	const alivePaneIds = useMemo(
		() =>
			new Set(
				(daemonSessions?.sessions ?? [])
					.filter((session) => session.isAlive)
					.map((session) => session.sessionId),
			),
		[daemonSessions],
	);
	// Panes whose PTY is alive but has no agent in it - Ctrl+C out of Claude and
	// the shell outlives the conversation. Filled in by the screen scan below.
	const [agentGonePaneIds, setAgentGonePaneIds] = useState<string[]>([]);
	/**
	 * PTY alive AND Claude still running in it. This - not the raw daemon poll -
	 * is what "the session is open" means to a card: everything a live pane is
	 * offered (Continue, its column, no Resume button) assumes there's a
	 * conversation on the other end, and a bare shell prompt is not one.
	 */
	const agentPaneIds = useMemo(
		() =>
			new Set([...alivePaneIds].filter((id) => !agentGonePaneIds.includes(id))),
		[alivePaneIds, agentGonePaneIds],
	);
	// Sessions under `/loop`, read from the same transcript query the loop pill
	// uses, so it's one fetch per session. Between ticks they belong in Idle -
	// every turn ends clean, but they aren't done.
	const sessionIdByPane = usePaneMeta((s) => s.sessionIdByPane);
	const loopCandidates = [...agentPaneIds].flatMap((paneId) => {
		const sessionId = panes[paneId]?.claudeSessionId ?? sessionIdByPane[paneId];
		return sessionId ? [{ paneId, sessionId }] : [];
	});
	const loopSessions = uniqueQueries(loopCandidates, (c) => c.sessionId);
	const loopQueries = electronTrpc.useQueries((t) =>
		loopSessions.unique.map(({ sessionId }) =>
			t.terminal.readClaudeTranscript(
				{ sessionId },
				{ retry: false, staleTime: 60_000, refetchInterval: 60_000 },
			),
		),
	);
	const loopingKey = loopCandidates
		.filter((_, i) => loopQueries[loopSessions.slot[i] ?? -1]?.data?.loop)
		.map(({ paneId }) => paneId)
		.join(",");
	const loopingPaneIds = useMemo(
		() => new Set(loopingKey ? loopingKey.split(",") : []),
		[loopingKey],
	);
	// Needs-you and Done sessions, open or closed, and the state of every PR
	// they linked. Once each is approved a Needs you card is Done: what's left is
	// a click, not a decision. While CI still runs on one, either card is
	// Working. Closed ones count - the approval usually lands after the session
	// went quiet, and a card closed for idling keeps its column. The
	// transcripts are the ones the cards' own pills already fetch.
	const mergeCandidates = Object.values(panes).flatMap((pane) => {
		const sessionId = pane.claudeSessionId ?? sessionIdByPane[pane.id];
		if (
			!sessionId ||
			(!pane.odinTaskTitle && !titleByPane[pane.id]) ||
			profileOf(pane.odinProfile) !== activeProfileId
		)
			return [];
		const alive =
			daemonSessions === undefined ? undefined : agentPaneIds.has(pane.id);
		const column = boardColumn(
			pane.status ?? "idle",
			alive,
			pane.odinParked ?? false,
			loopingPaneIds.has(pane.id),
			pane.odinClosedIn,
		);
		return column === "permission" || column === "review"
			? [
					{
						paneId: pane.id,
						sessionId,
						live: !!alive,
						brief: pane.odinBrief,
						column,
					},
				]
			: [];
	});
	// One query per conversation and per PR list, mapped back to the cards.
	const mergeSessions = uniqueQueries(mergeCandidates, (c) => c.sessionId);
	const liveSessionIds = new Set(
		mergeCandidates.filter((c) => c.live).map((c) => c.sessionId),
	);
	const mergeTranscriptQueries = electronTrpc.useQueries((t) =>
		mergeSessions.unique.map(({ sessionId }) =>
			t.terminal.readClaudeTranscript(
				{ sessionId },
				{
					retry: false,
					staleTime: 60_000,
					refetchInterval: liveSessionIds.has(sessionId) ? 60_000 : false,
				},
			),
		),
	);
	const mergeTranscripts = mergeCandidates.map(
		(_, i) => mergeTranscriptQueries[mergeSessions.slot[i] ?? -1],
	);
	const mergeUrlLists = uniqueQueries(
		mergeCandidates.map(({ brief }, i) => {
			const messages = mergeTranscripts[i]?.data?.messages ?? [];
			const reviewed = reviewedPullRequest(brief, messages);
			const urls = mergeCheckUrls(messages);
			if (reviewed && !urls.includes(reviewed.url)) urls.push(reviewed.url);
			return urls;
		}),
		(urls) => JSON.stringify(urls),
	);
	const mergeStateResults = electronTrpc.useQueries((t) =>
		mergeUrlLists.unique.map((urls) =>
			t.terminal.pullRequestStates(
				{ urls },
				{
					enabled: urls.length > 0,
					retry: false,
					staleTime: 30_000,
					refetchInterval: 60_000,
				},
			),
		),
	);
	const mergeStateQueries = mergeCandidates.map(
		(_, i) => mergeStateResults[mergeUrlLists.slot[i] ?? -1],
	);
	// Needs you cards only, unless `anyColumn`: Done ones are here for CI.
	const candidateKey = (
		test: (
			messages: BriefMessage[],
			states: Parameters<typeof mergeReady>[1] | undefined,
			brief: string | null | undefined,
		) => boolean,
		anyColumn = false,
	) =>
		mergeCandidates
			.filter(({ brief, column }, i) => {
				if (!anyColumn && column !== "permission") return false;
				const messages = mergeTranscripts[i]?.data?.messages;
				return !!messages && test(messages, mergeStateQueries[i]?.data, brief);
			})
			.map(({ paneId }) => paneId)
			.join(",");
	const mergeReadyKey = candidateKey(
		(messages, states, brief) =>
			onlyLookLeft(messages) ||
			(!!states &&
				(mergeReady(messages, states) ||
					prsDropped(messages, states) ||
					!!reviewEnded(reviewedPullRequest(brief, messages), states))),
	);
	const droppedKey = candidateKey(
		(messages, states, brief) =>
			!!states &&
			(prsDropped(messages, states) ||
				reviewEnded(reviewedPullRequest(brief, messages), states) === "CLOSED"),
	);
	const reviewMergedKey = candidateKey(
		(messages, states, brief) =>
			!!states &&
			reviewEnded(reviewedPullRequest(brief, messages), states) === "MERGED",
	);
	const reviewMergedPaneIds = useMemo(
		() => new Set(reviewMergedKey ? reviewMergedKey.split(",") : []),
		[reviewMergedKey],
	);
	const mergeReadyPaneIds = useMemo(
		() => new Set(mergeReadyKey ? mergeReadyKey.split(",") : []),
		[mergeReadyKey],
	);
	// pane id -> the checks still running on its PRs. Keyed by a string so the
	// map only changes when a check starts or ends.
	const ciKey = mergeCandidates
		.map(({ paneId }, i) => {
			const states = mergeStateQueries[i]?.data;
			const checks = states ? ciRunning(states) : [];
			return checks.length ? `${paneId}\t${checks.join("\t")}` : "";
		})
		.filter(Boolean)
		.join("\n");
	const ciChecksByPane = useMemo(
		() =>
			new Map(
				ciKey
					? ciKey.split("\n").map((line) => {
							const [paneId = "", ...checks] = line.split("\t");
							return [paneId, checks];
						})
					: [],
			),
		[ciKey],
	);
	const droppedPaneIds = useMemo(
		() => new Set(droppedKey ? droppedKey.split(",") : []),
		[droppedKey],
	);
	/** See mergeStateColumn. */
	const withMergeReady = useCallback(
		(column: PaneStatus, paneId: string): PaneStatus =>
			mergeStateColumn(
				column,
				ciChecksByPane.has(paneId),
				mergeReadyPaneIds.has(paneId),
			),
		[mergeReadyPaneIds, ciChecksByPane],
	);
	// Screen-reading keeps the columns honest. Agent hooks are the fast path,
	// but they go missing - Stop doesn't fire on Ctrl+C, a notification can miss
	// a pane that wasn't in the store yet, and statuses reset to idle on reload
	// while the PTYs live on. Any of those strands a card mid-flight ("Working"
	// forever on a session that's been sitting at its prompt for an hour), so
	// re-read every live board session on a timer instead of once.
	const setPaneStatusFromStore = useTabsStore((state) => state.setPaneStatus);
	const readingRef = useRef(new Set<string>());
	/** Panes whose last scan read the idle prompt - see the write below. */
	const sawIdlePromptRef = useRef(new Set<string>());
	/** Panes whose last scan found no Claude on screen - same doubt, same fix. */
	const sawNoAgentRef = useRef(new Set<string>());
	const lastScanRef = useRef(0);
	useEffect(() => {
		const scan = () => {
			// `panes` changes on every status write, which re-runs this effect and
			// would otherwise re-read every screen again straight away.
			if (Date.now() - lastScanRef.current < 3_000) return;
			lastScanRef.current = Date.now();
			for (const pane of Object.values(panes)) {
				// You parked it - don't let screen-reading drag it back out of Idle.
				if (pane.odinParked) continue;
				// Nothing to read: a queued task has no process yet.
				if (pane.odinQueued) continue;
				// The hooks and this scan are two writers to one status, and while a
				// turn is running the hooks rewrite it every few seconds. Reading the
				// screen in between only has to be wrong once for the card to flip
				// Working → Needs you → Working. So don't arbitrate: the hooks win
				// while they're live, and this steps in once a status has gone quiet
				// - which is the only case it exists for, because a hook that never
				// arrives leaves the card stuck for hours, not for seconds.
				// Quiet means the *hooks* have stopped talking, not that the status
				// stopped changing. They aren't the same thing: setPaneStatus no-ops
				// on an unchanged value, so a turn's worth of "working" hooks never
				// moves `statusSince` - which left this scan re-reading the screen of
				// every live session every 5 seconds, all turn, and a single bad read
				// bounced the card to Needs you until the next hook bounced it back.
				const since = Math.max(
					statusSinceRef.current.get(pane.id)?.at ?? 0,
					lastAgentHookAt.get(pane.id) ?? 0,
				);
				if (Date.now() - since < SETTLED_MS) continue;
				// Board sessions only - never attach to a terminal the board doesn't own.
				if (!pane.odinTaskTitle && !titleByPane[pane.id]) continue;
				if (!alivePaneIds.has(pane.id)) continue;
				// A read is already in flight for this pane - don't stack them.
				if (readingRef.current.has(pane.id)) continue;
				const tab = tabs.find((item) => item.id === pane.tabId);
				if (!tab) continue;
				readingRef.current.add(pane.id);
				// Reading a screen must not resize the session. createOrAttach hands
				// the host a viewport, and a host old enough to fill in a missing one
				// resizes the live PTY to 80x24 - Claude repaints its TUI at 80
				// columns inside whatever the drawer is actually showing. Send the
				// size the mounted xterm already has, so the resize is a no-op.
				const mounted = terminalCache.get(pane.id)?.xterm;
				(async () => {
					try {
						const result = (await utils.client.terminal.createOrAttach.mutate({
							paneId: pane.id,
							tabId: pane.tabId,
							workspaceId: tab.workspaceId,
							skipColdRestore: true,
							// A read joins an attach already in flight instead of
							// superseding it. Main keeps one pending attach per pane and
							// aborts the older one; when that was the drawer's, its
							// Terminal drops the cancel silently and never starts its
							// stream - a blank drawer until you close and reopen it.
							joinPending: true,
							...(mounted && { cols: mounted.cols, rows: mounted.rows }),
						})) as {
							snapshot?: { snapshotAnsi?: string };
							scrollback?: string;
						};
						const screen = (
							result?.snapshot?.snapshotAnsi ??
							result?.scrollback ??
							""
						)
							.replace(ANSI_RE, "")
							.slice(-2500);
						// The PTY outliving the agent is its own state: Ctrl+C out of
						// Claude and the shell is still there, alive to the daemon
						// with no conversation in it. Two reads have to agree -
						// a snapshot caught mid-repaint can come back with none of
						// Claude's chrome on it.
						const gone = !agentOnScreen(screen);
						const goneTwice = gone && sawNoAgentRef.current.has(pane.id);
						if (gone) sawNoAgentRef.current.add(pane.id);
						else sawNoAgentRef.current.delete(pane.id);
						setAgentGonePaneIds((ids) => {
							const next = goneTwice
								? [...new Set([...ids, pane.id])]
								: ids.filter((id) => id !== pane.id);
							return next.length === ids.length ? ids : next;
						});
						// `pane` was captured before the await - read the status the
						// hooks hold now, not the one they held when the scan started.
						const read = odinScreenStatus(screen);
						const current = useTabsStore.getState().panes[pane.id]?.status;
						// The one read worth doubting. A dialog and a spinner are
						// things Claude drew; "sitting at the prompt" is the absence
						// of both, which is also what a snapshot caught mid-repaint
						// looks like - and taking it at face value is what yanked a
						// working card into Needs you until the next hook yanked it
						// back. A tool call outlasting SETTLED_MS still gets here, so
						// make this one wait for a second scan to agree.
						if (read === "review" && current === "working") {
							if (!sawIdlePromptRef.current.has(pane.id)) {
								sawIdlePromptRef.current.add(pane.id);
								return;
							}
						} else {
							sawIdlePromptRef.current.delete(pane.id);
						}
						const status = odinScreenWrite(read, current);
						// An unreadable screen, or one that can't improve on what the
						// hooks already said, leaves the status alone.
						if (status) setPaneStatusFromStore(pane.id, status);
					} catch {
						// leave it be - the next scan or agent event will correct it
					} finally {
						readingRef.current.delete(pane.id);
					}
					// NOTE: do NOT detach here. The whole app shares one socket to the
					// daemon, so detach({paneId}) tears down the stream for the drawer's
					// live terminal too - which was making it render blank.
				})();
			}
		};
		scan();
		const id = setInterval(scan, 5_000);
		return () => clearInterval(id);
	}, [panes, tabs, alivePaneIds, utils, setPaneStatusFromStore, titleByPane]);

	/** The column a session's card sits in. */
	const columnOf = useCallback(
		(pane: Pane): PaneStatus =>
			withMergeReady(
				boardColumn(
					pane.status ?? "idle",
					// `undefined` = the poll hasn't answered yet, which is not "dead".
					daemonSessions === undefined ? undefined : agentPaneIds.has(pane.id),
					pane.odinParked ?? false,
					loopingPaneIds.has(pane.id),
					pane.odinClosedIn,
				),
				pane.id,
			),
		[daemonSessions, agentPaneIds, loopingPaneIds, withMergeReady],
	);

	return {
		daemonSessions,
		alivePaneIds,
		agentPaneIds,
		setAgentGonePaneIds,
		sawNoAgentRef,
		statusSinceRef,
		loopingPaneIds,
		ciChecksByPane,
		droppedPaneIds,
		reviewMergedPaneIds,
		withMergeReady,
		columnOf,
	};
}
