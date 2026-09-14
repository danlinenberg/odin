import { boardColumn } from "shared/board-column";
import type {
	AgentLifecycleEvent,
	NotificationIds,
} from "shared/notification-types";
import type { PaneStatus } from "shared/tabs-types";
import { isPaneVisible } from "./utils";

const NOTIFICATION_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface NativeNotification {
	show(): void;
	close(): void;
	on(event: "click", handler: () => void): void;
	on(event: "close", handler: () => void): void;
}

export interface NotificationManagerDeps {
	isSupported: () => boolean;
	createNotification: (opts: {
		title: string;
		body: string;
		silent: boolean;
	}) => NativeNotification;
	playSound: () => void;
	onNotificationClick: (ids: NotificationIds) => void;
	getVisibilityContext: () => {
		isFocused: boolean;
		currentWorkspaceId: string | null;
		tabsState:
			| {
					activeTabIds?: Record<string, string | null>;
					focusedPaneIds?: Record<string, string>;
			  }
			| undefined;
	};
	/** Null when the event belongs to no known pane. */
	getNotificationTitle: (event: AgentLifecycleEvent) => string | null;
	/** Whether the card was dragged to Idle, the one Needs you exemption. */
	isParked: (event: AgentLifecycleEvent) => boolean;
}

interface TrackedEntry {
	notification: NativeNotification;
	createdAt: number;
}

export class NotificationManager {
	private active = new Map<string, TrackedEntry>();
	// Sessions currently sitting in Needs you, so a move into it can be told apart
	// from another event once it's there.
	// ponytail: one id per session seen since launch; give it the sweep's TTL
	// treatment if that ever adds up.
	private waiting = new Set<string>();
	private counter = 0;
	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private deps: NotificationManagerDeps) {}

	start(): void {
		if (this.sweepTimer) return;
		this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
	}

	handleAgentLifecycle(event: AgentLifecycleEvent): void {
		const stateKey = event.sessionId ?? event.paneId;

		// Working again — the next Needs you event is a fresh arrival, not a repeat.
		if (event.eventType === "Start") {
			if (stateKey) this.waiting.delete(stateKey);
			return;
		}
		if (!this.deps.isSupported()) return;

		if (!this.isNeedsYou(event)) {
			if (stateKey) this.waiting.delete(stateKey);
			return;
		}
		// Notify on the move into Needs you, not on every event once it's there.
		// Claude's Stop hook fires on every turn, so a session already waiting on
		// you would otherwise re-banner for each one.
		if (stateKey) {
			if (this.waiting.has(stateKey)) return;
			this.waiting.add(stateKey);
		}

		if (this.shouldSuppressForVisiblePane(event)) return;

		// No pane, no name, and nothing for a click to land on — the agent is
		// running outside Odin. Banners for those read "Terminal needs you".
		const task = this.deps.getNotificationTitle(event);
		if (!task) return;

		const isWaitingOnReply =
			event.eventType === "PermissionRequest" ||
			event.eventType === "PendingQuestion";
		const notification = this.deps.createNotification({
			title: `${task} needs you`,
			body: isWaitingOnReply ? "Waiting for your reply" : "Finished its turn",
			silent: true,
		});

		const key = event.sessionId ?? event.paneId ?? `_anon_${this.counter++}`;
		this.track(key, notification);

		this.deps.playSound();

		notification.on("click", () => {
			this.deps.onNotificationClick({
				paneId: event.paneId,
				tabId: event.tabId,
				workspaceId: event.workspaceId,
				sessionId: event.sessionId,
				...(event.terminalId ? { terminalId: event.terminalId } : {}),
			});
			this.untrack(key, notification);
		});

		notification.on("close", () => {
			this.untrack(key, notification);
		});

		notification.show();
	}

	/** Number of tracked notifications (for testing). */
	get activeCount(): number {
		return this.active.size;
	}

	dispose(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
		this.active.clear();
		this.waiting.clear();
	}

	/**
	 * True when this event puts the session in the board's Needs you column.
	 *
	 * The board is the contract: a banner should mean the same thing as a card
	 * landing in Needs you, so the rule lives in `boardColumn` and is read from
	 * here rather than restated. Two inputs it can't look up:
	 *
	 * `alive` is always true — a lifecycle hook is the agent's own process
	 * reporting in, which is proof of life. Reading the daemon poll instead would
	 * only add a way to be wrong.
	 *
	 * The status is derived from the event, not from the pane. A `Stop` means the
	 * turn just ended, which is idle-or-review either way, and both land in Needs
	 * you. The pane's persisted status still says "working" at this point, because
	 * only the renderer clears it, so trusting it would drop the notification
	 * whenever the hook wins that race.
	 */
	private isNeedsYou(event: AgentLifecycleEvent): boolean {
		const status: PaneStatus =
			event.eventType === "Stop" ? "idle" : "permission";
		return (
			boardColumn(status, true, this.deps.isParked(event)) === "permission"
		);
	}

	private shouldSuppressForVisiblePane(event: AgentLifecycleEvent): boolean {
		if (!event.workspaceId || !event.tabId || !event.paneId) return false;

		const ctx = this.deps.getVisibilityContext();
		if (!ctx.isFocused) return false;

		return isPaneVisible({
			currentWorkspaceId: ctx.currentWorkspaceId,
			tabsState: ctx.tabsState,
			pane: {
				workspaceId: event.workspaceId,
				tabId: event.tabId,
				paneId: event.paneId,
			},
		});
	}

	private track(key: string, notification: NativeNotification): void {
		const prev = this.active.get(key);
		if (prev) {
			prev.notification.close();
		}
		this.active.set(key, { notification, createdAt: Date.now() });
	}

	private untrack(key: string, notification?: NativeNotification): void {
		const current = this.active.get(key);
		if (!current) return;
		if (notification && current.notification !== notification) return;
		this.active.delete(key);
	}

	private sweep(): void {
		const now = Date.now();
		for (const [key, entry] of this.active) {
			if (now - entry.createdAt > NOTIFICATION_TTL_MS) {
				this.active.delete(key);
			}
		}
	}
}
