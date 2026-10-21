import { useEffect, useRef } from "react";
import { quote, worktreeMadeLine } from "renderer/hooks/useLaunchTaskSession";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { claudeLaunch } from "renderer/stores/claude-command";
import { launchLimits, useLaunchLimits } from "renderer/stores/launch-limits";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane } from "renderer/stores/tabs/types";
import { claimedCheckout, launchBlocker } from "shared/launch-gate";

/**
 * Tasks created while the gate was shut, oldest first.
 *
 * Insertion order is creation order - panes are keyed by uuid and the store
 * rebuilds them from the persisted array in the same order - so the queue is
 * first-come-first-served without carrying a timestamp around.
 */
export function queuedPanes(panes: Record<string, Pane>): Pane[] {
	return Object.values(panes).filter((pane) => !!pane.odinQueued);
}

/** Where a queued pane's agent runs - set at launch, never confirmed since. */
function queuedCwd(pane: Pane): string {
	return pane.initialCwd ?? pane.cwd ?? "";
}

/**
 * The checkout a queued pane will claim when it starts - what the gate
 * compares. `odinCwd` survives opening the card; `initialCwd` doesn't.
 */
function queuedCheckout(pane: Pane, odinRepoPath: string | null | undefined) {
	return (
		pane.odinCwd ?? claimedCheckout(undefined, queuedCwd(pane), odinRepoPath)
	);
}

/** Panes whose PTY is alive in the daemon - the only ones that can be working. */
export function livePanes(
	panes: Record<string, Pane>,
	sessions: { sessionId: string; isAlive: boolean }[],
): Pane[] {
	const alive = new Set(
		sessions.filter((s) => s.isAlive).map((s) => s.sessionId),
	);
	return Object.values(panes).filter((pane) => alive.has(pane.id));
}

type TrpcClient = ReturnType<typeof electronTrpc.useUtils>["client"];

/**
 * When a session last started on this Mac and on the remote host, from any
 * path: a launch, a Resume, the queue. The gates read the machine's load, and
 * a reading lags a start, so a burst - a bulk Resume, Huginn starting five
 * tasks - would pass them all at once. Each start waits for the one before it
 * to show up.
 */
const lastStart = { mac: 0, host: 0 };

/** The Mac's metrics poll: a start this recent isn't in the reading yet. */
export const MAC_START_GAP_MS = 5_000;

export function markStarted(where: "mac" | "host", at = Date.now()): void {
	lastStart[where] = at;
}

/** Whether a host reading taken at `at` was taken after the last host start. */
export function hostReadSinceStart(at: number | null | undefined): boolean {
	return (at ?? Number.POSITIVE_INFINITY) > lastStart.host;
}

/**
 * Too soon after the last start on the Mac, or null - and then the start is
 * this caller's, so the next one waits for it.
 */
export function macPaceBlocker(now = Date.now()): string | null {
	if (now - lastStart.mac < MAC_START_GAP_MS)
		return "waiting for the session started a moment ago to show up";
	markStarted("mac", now);
	return null;
}

/**
 * `remoteLaunchBlocker` read now, for a one-off launch or Resume on the host.
 * It also waits for a reading taken after the last start there, as the queue
 * does. A pass takes the start. A failed read lets it through.
 */
export async function currentHostBlocker(
	client: TrpcClient,
): Promise<string | null> {
	const gate = await client.remoteHost.launchGate.query().catch(() => null);
	if (gate?.reason) return gate.reason;
	if (gate && !hostReadSinceStart(gate.at))
		return "waiting for the host's next reading after the last start";
	markStarted("host");
	return null;
}

/**
 * `launchBlocker` against the live Mac and the live PTYs, read now - for a
 * one-off decision (a launch, a Resume) rather than the queue's poll.
 * `except` leaves a pane out: a Resume's own card can't block itself.
 */
export async function currentLaunchBlocker(
	client: TrpcClient,
	checkout: string,
	odinRepoPath: string | null | undefined,
	except?: string,
): Promise<string | null> {
	const [snapshot, { sessions }] = await Promise.all([
		client.resourceMetrics.getSnapshot.query(),
		client.terminal.listDaemonSessions.query(),
	]);
	return launchBlocker(
		snapshot,
		livePanes(useTabsStore.getState().panes, sessions).filter(
			(pane) => pane.id !== except,
		),
		checkout,
		odinRepoPath,
		launchLimits(useLaunchLimits.getState()),
	);
}

/**
 * Start a task that was held back: spawn the command its launch parked on the
 * pane, and clear the queue flag so the card leaves the Queued section.
 *
 * Killed first, like Resume does: opening a queued card in the workspace view
 * mounts a terminal, which attaches a plain shell to the pane - and
 * `createOrAttach` on a pane that already has a session ignores the command,
 * so the agent would never start. `allowKilled` for the same reason the pane
 * needs killing at all.
 */
export async function startQueuedPane(
	client: TrpcClient,
	pane: Pane,
): Promise<void> {
	const queued = pane.odinQueued;
	if (!queued) return;
	const tab = useTabsStore.getState().tabs.find((tab) => tab.id === pane.tabId);
	if (!tab) return;
	// A host launch's command carries a token ticket that expires in minutes,
	// so it is built now rather than when the launch was queued.
	const command = queued.remote
		? await client.remoteHost.sessionCommand.mutate({
				...queued.remote,
				odinPane: pane.id,
			})
		: queued.command;
	await client.terminal.kill.mutate({ paneId: pane.id }).catch(() => {});
	await client.terminal.createOrAttach.mutate({
		paneId: pane.id,
		tabId: pane.tabId,
		workspaceId: tab.workspaceId,
		cwd: queuedCwd(pane),
		command,
		allowKilled: true,
	});
	useTabsStore.setState((state) => ({
		panes: {
			...state.panes,
			[pane.id]: {
				...state.panes[pane.id],
				// A Resume reopens at an idle prompt - nothing was asked of it -
				// unless it was queued with "Continue" on the end. A host
				// command hides its args, so a host Resume reads its own.
				status: (
					queued.remote
						? queued.remote.claudeArgs.startsWith("--resume") &&
							!queued.remote.prompt
						: / --(resume|continue)\b/.test(command) &&
							!command.endsWith(" Continue")
				)
					? "idle"
					: "working",
				odinQueued: undefined,
			},
		},
	}));
}

/**
 * With sessions on the remote host, a new task held back on this Mac starts
 * there instead: the host has its own room and gives each session its own
 * worktree, so neither gate applies. A Resume stays: it runs where its
 * conversation is saved. False when the task can't go (a Resume, or a feed
 * whose connector isn't on the host).
 */
export async function moveQueuedToHost(
	client: TrpcClient,
	pane: Pane,
): Promise<boolean> {
	// Moved already, and its start failed: start it again, still on the host.
	if (pane.odinQueued && pane.odinRemote) {
		await startQueuedPane(client, pane);
		return true;
	}
	const queued = pane.odinQueued;
	const sessionId = queued?.command.match(/--session-id ([\w-]+)/)?.[1];
	const promptPath = queued?.command.match(/"\$\(cat '([^']+)'\)"/)?.[1];
	const tab = useTabsStore.getState().tabs.find((tab) => tab.id === pane.tabId);
	if (!queued || !sessionId || !promptPath || !tab) return false;
	const host = await client.remoteHost.launchTarget.query({
		repoPath: pane.odinCwd ?? null,
		source: pane.odinSource ?? null,
	});
	if (!host) return false;
	const read = await client.filesystem.readFile.query({
		workspaceId: tab.workspaceId,
		absolutePath: promptPath,
		encoding: "utf-8",
	});
	if (read.kind !== "text") return false;
	// The host makes its own worktree; the one made on this Mac isn't there.
	const prompt = read.content
		.split("\n")
		.filter(
			(line) =>
				!line.startsWith("Odin made this session its own git worktree:"),
		)
		.join("\n");
	// startQueuedPane builds the host command from these.
	const remote = {
		pane: sessionId,
		repoPath: pane.odinCwd ?? null,
		claudeArgs: `--session-id ${sessionId}`,
		prompt,
	};
	const moved = {
		...pane,
		odinRemote: host,
		odinQueued: { ...queued, remote },
	};
	useTabsStore.setState((state) => ({
		panes: { ...state.panes, [pane.id]: { ...state.panes[pane.id], ...moved } },
	}));
	await startQueuedPane(client, moved);
	return true;
}

/**
 * The other way: a new task waiting on the remote host's room starts on this
 * Mac now instead, in its own worktree like any local launch. False when it
 * can't (a Resume, whose conversation is saved on the host).
 */
export async function moveQueuedToMac(
	client: TrpcClient,
	pane: Pane,
): Promise<boolean> {
	const remote = pane.odinQueued?.remote;
	const tab = useTabsStore.getState().tabs.find((tab) => tab.id === pane.tabId);
	if (!pane.odinQueued || !remote?.prompt || !tab) return false;
	const workspace = await client.workspaces.get.query({ id: tab.workspaceId });
	if (!workspace?.worktreePath) return false;
	const title = pane.odinTaskTitle ?? "task";
	const worktree = remote.repoPath
		? await client.repos.createSessionWorktree
				.mutate({ repo: remote.repoPath, title })
				.catch(() => null)
		: null;
	const cwd = worktree?.path || remote.repoPath || workspace.worktreePath;
	await client.repos.trustForClaude.mutate({ path: cwd }).catch(() => {});
	const promptPath = `${workspace.worktreePath}/.odin/task-${remote.pane}.md`;
	await client.filesystem.writeFile.mutate({
		workspaceId: tab.workspaceId,
		absolutePath: promptPath,
		content: worktree
			? `${remote.prompt}\n\n${worktreeMadeLine(worktree)}`
			: remote.prompt,
		encoding: "utf-8",
	});
	const command = `cd ${quote(cwd)} && ${claudeLaunch(title, `${remote.claudeArgs} "$(cat '${promptPath}')"`, pane.id)}`;
	const moved: Pane = {
		...pane,
		initialCwd: cwd,
		odinRemote: undefined,
		odinQueued: { command, reason: pane.odinQueued.reason },
		...(worktree ? { odinCwd: worktree.path } : {}),
	};
	useTabsStore.setState((state) => ({
		panes: { ...state.panes, [pane.id]: { ...state.panes[pane.id], ...moved } },
	}));
	await startQueuedPane(client, moved);
	return true;
}

/**
 * Rewrite each waiting card's "why" to what's holding it now. The reason is
 * stamped at queue time, so without this a card kept naming a session that had
 * long since stopped.
 */
function refreshQueuedReasons(
	queue: Pane[],
	reasonFor: (pane: Pane) => string,
): void {
	const stale = queue.filter(
		(pane) => pane.odinQueued && pane.odinQueued.reason !== reasonFor(pane),
	);
	if (!stale.length) return;
	useTabsStore.setState((state) => {
		const panes = { ...state.panes };
		for (const pane of stale) {
			const current = panes[pane.id];
			if (!current?.odinQueued) continue;
			panes[pane.id] = {
				...current,
				odinQueued: { ...current.odinQueued, reason: reasonFor(pane) },
			};
		}
		return { panes };
	});
}

/**
 * Each waiting card's "why": only the head waits on the blocker; the rest
 * wait on the card ahead, so repeating the blocker on every card says nothing
 * new.
 */
function inLine(queue: Pane[], blocker: string) {
	return (pane: Pane) => {
		const place = queue.indexOf(pane);
		return place === 0
			? blocker
			: `#${place + 1} in line, after "${queue[place - 1].odinTaskTitle ?? queue[place - 1].name}"`;
	};
}

/**
 * The clock behind the Queued section: every poll, if the gate is open, start
 * the task that has waited longest.
 *
 * One per tick, deliberately - the session it just started turns the Odin gate
 * red and shows up in the next CPU reading, so the tick after it re-decides
 * against a machine that actually has the new agent on it.
 *
 * Mounted in the Odin shell rather than on the board: a queue that only drains
 * while you're looking at it isn't one.
 */
export function useTaskQueue(): void {
	const utils = electronTrpc.useUtils();
	const { data: workConfig } = electronTrpc.work.getConfig.useQuery();
	const { data: remoteHost } = electronTrpc.remoteHost.get.useQuery(undefined, {
		refetchInterval: 30_000,
	});
	// Cards that can't go to the host, so the queue doesn't retry them forever.
	const stayHere = useRef(new Set<string>());
	// The same 5s snapshot the header chip reads - one shared query.
	const { data: metrics } = electronTrpc.resourceMetrics.getSnapshot.useQuery(
		undefined,
		{ refetchInterval: 5_000 },
	);
	// Which PTYs are actually running. A restart kills every PTY but keeps each
	// pane's "working" status, so without this a dead card counted toward the
	// cap - and held its checkout - for good, and the queue never drained.
	const { data: daemonSessions } =
		electronTrpc.terminal.listDaemonSessions.useQuery(undefined, {
			refetchInterval: 5_000,
		});
	// The host's memory and load, read only while something waits to go
	// there: remote panes report it every 30s, so this costs the host nothing
	// more then.
	const hostOn = !!remoteHost?.host?.on;
	const waitingForHost = useTabsStore((state) =>
		Object.values(state.panes).some(
			(pane) => !!pane.odinQueued && (!!pane.odinRemote || hostOn),
		),
	);
	const hostGate = electronTrpc.remoteHost.launchGate.useQuery(undefined, {
		enabled: waitingForHost && !!remoteHost?.host,
		refetchInterval: 5_000,
	});
	// A spawn takes a second or two; without this the next poll starts the same
	// card again while the first attach is still in flight.
	const starting = useRef(false);

	useEffect(() => {
		if (!metrics || !daemonSessions || starting.current) return;
		const panes = useTabsStore.getState().panes;
		const queue = queuedPanes(panes);
		if (!queue.length) return;
		// Bound for the host: moved there already, or anything that can go
		// while the host is on for new sessions.
		const hostBound = queue.filter(
			(pane) =>
				pane.odinRemote ||
				(remoteHost?.host?.on && !stayHere.current.has(pane.id)),
		);
		// One already moved to the host starts first.
		const toHost = hostBound.find((pane) => pane.odinRemote) ?? hostBound[0];
		const hostWait = hostGate.data?.reason ?? null;
		// The next host start waits for a reading taken after the last one,
		// so a burst can't outrun the readings.
		const readSinceStart =
			hostGate.isFetched && hostReadSinceStart(hostGate.data?.at);
		if (toHost && !hostWait && readSinceStart) {
			starting.current = true;
			void moveQueuedToHost(utils.client, toHost)
				.then((moved) => {
					if (moved) markStarted("host");
					else stayHere.current.add(toHost.id);
				})
				.catch(() => {
					// Left queued - the next tick tries again.
				})
				.finally(() => {
					starting.current = false;
				});
			return;
		}
		if (hostWait) refreshQueuedReasons(hostBound, inLine(hostBound, hostWait));
		const local = queue.filter((pane) => !hostBound.includes(pane));
		if (!local.length) return;
		const live = livePanes(panes, daemonSessions.sessions);
		const blockerFor = (pane: Pane) =>
			launchBlocker(
				metrics,
				live,
				queuedCheckout(pane, workConfig?.odinRepoPath),
				workConfig?.odinRepoPath,
				launchLimits(useLaunchLimits.getState()),
			);
		// The longest-waiting card that can go now - a card waiting on its own
		// busy repo doesn't hold back one aimed at a free repo.
		const next = local.find((pane) => !blockerFor(pane));
		if (!next) {
			refreshQueuedReasons(local, inLine(local, blockerFor(local[0]) ?? ""));
			return;
		}
		if (macPaceBlocker()) return;
		starting.current = true;
		void startQueuedPane(utils.client, next)
			.catch(() => {
				// Leave it queued - the next tick tries again.
			})
			.finally(() => {
				starting.current = false;
			});
	}, [
		metrics,
		daemonSessions,
		workConfig,
		remoteHost,
		hostGate.data,
		hostGate.isFetched,
		utils,
	]);
}
