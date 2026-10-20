import { useEffect } from "react";
import {
	getRemoteCoreTarget,
	onRemoteCoreTargetChange,
	remoteCoreClient,
} from "renderer/lib/remote-core-link";
import { useClaudeCommand } from "renderer/stores/claude-command";
import { useDoneStore } from "renderer/stores/done";
import { useIdleClose } from "renderer/stores/idle-close";
import { useLaunchLimits } from "renderer/stores/launch-limits";
import { useNextInLinePrompt } from "renderer/stores/next-in-line-prompt";
import { useOdinRules } from "renderer/stores/odin-rules";
import { useOneByOne } from "renderer/stores/one-by-one";
import { useSessionInstructions } from "renderer/stores/session-instructions";
import { useTitleOverrides } from "../all/title-overrides";
import { useReminders } from "../components/Reminders";
import { useReplyWatch } from "../components/ReplyWatch";
import { useBacklogReview } from "./useBacklogReview";
import { useOdinTasks } from "./useOdinTasks";
import { usePaneMeta } from "./usePaneMeta";

/**
 * Mirror the window's own state to the remote server, so the server's
 * schedulers (automations, Night Agent, reminders...) act on what you set up
 * here while the laptop is shut. The stores stay exactly as they are; this
 * copies each one's persisted JSON (its localStorage value) up when it
 * changes, and on connect takes whichever side changed last - edits made
 * offline go up, edits made from another machine come down.
 *
 * Only these stores, which the user edits. Scheduler bookkeeping lives under
 * the server's own `server:` keys and never round-trips through here.
 */

interface PersistedStore {
	subscribe: (listener: () => void) => () => void;
	persist: {
		getOptions: () => { name?: string };
		rehydrate: () => Promise<void> | void;
	};
}

const MIRRORED: PersistedStore[] = [
	useOdinTasks,
	useNextInLinePrompt,
	useLaunchLimits,
	useClaudeCommand,
	useOdinRules,
	useSessionInstructions,
	useOneByOne,
	useDoneStore,
	useIdleClose,
	useReminders,
	useReplyWatch,
	useBacklogReview,
	usePaneMeta,
	useTitleOverrides,
] as unknown as PersistedStore[];

/** When each key last changed on this machine, as the mirror knows it. */
const META_KEY = "odin-state-mirror";
const PUSH_DELAY_MS = 800;
const PULL_EVERY_MS = 60_000;

function readMeta(): Record<string, number> {
	try {
		return JSON.parse(localStorage.getItem(META_KEY) ?? "{}");
	} catch {
		return {};
	}
}

function writeMeta(meta: Record<string, number>): void {
	try {
		localStorage.setItem(META_KEY, JSON.stringify(meta));
	} catch {
		// Storage full or unavailable - the next change retries.
	}
}

const client = remoteCoreClient;

const storeByKey = new Map<string, PersistedStore>();
for (const store of MIRRORED) {
	const name = store.persist.getOptions().name;
	if (name) storeByKey.set(name, store);
}

/** Keys being written from the server right now: their change isn't ours to push. */
const adopting = new Set<string>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

async function adopt(
	key: string,
	entry: { value: string; updatedAt: number },
): Promise<void> {
	adopting.add(key);
	try {
		localStorage.setItem(key, entry.value);
		await storeByKey.get(key)?.persist.rehydrate();
		writeMeta({ ...readMeta(), [key]: entry.updatedAt });
	} finally {
		adopting.delete(key);
	}
}

async function push(key: string): Promise<void> {
	const api = client();
	const value = localStorage.getItem(key);
	if (!api || value === null) return;
	const updatedAt = readMeta()[key] ?? Date.now();
	const result = await api.state.set.mutate({ key, value, updatedAt });
	// The server had a newer copy (changed from another machine): take it.
	if (!result.applied && result.current) await adopt(key, result.current);
}

function schedulePush(key: string): void {
	clearTimeout(pending.get(key));
	pending.set(
		key,
		setTimeout(() => {
			pending.delete(key);
			push(key).catch((error) =>
				console.warn(`[state-mirror] push ${key} failed:`, error),
			);
		}, PUSH_DELAY_MS),
	);
}

/** Reconcile every key with the server: newer side wins. */
async function sync(): Promise<void> {
	const api = client();
	if (!api) return;
	const keys = [...storeByKey.keys()];
	const remote = await api.state.get.query({ keys });
	const meta = readMeta();
	for (const key of keys) {
		const server = remote[key];
		const hasLocal = localStorage.getItem(key) !== null;
		// A value written before the mirror existed counts as oldest.
		const local = meta[key] ?? (hasLocal ? 1 : 0);
		if (server && server.updatedAt > local) {
			await adopt(key, server);
		} else if (hasLocal && (!server || local > server.updatedAt)) {
			if (!meta[key]) writeMeta({ ...readMeta(), [key]: Date.now() });
			await push(key);
		}
	}
}

/** Plain JSON keys last pushed (shared/server-board.ts), so an unchanged value isn't re-sent. */
const lastPushed = new Map<string, string>();

/**
 * Push a plain JSON key the window owns (where sessions start, the board's
 * cards, the Night Agent's queue) when its value changed.
 */
export async function mirrorJson(key: string, value: unknown): Promise<void> {
	const api = client();
	if (!api) return;
	const json = JSON.stringify(value);
	if (lastPushed.get(key) === json) return;
	await api.state.set.mutate({ key, value: json, updatedAt: Date.now() });
	lastPushed.set(key, json);
}

/** Server-written keys (`server:*`), parsed; a missing or unreadable one is absent. */
export async function readServerState(
	keys: string[],
): Promise<Record<string, unknown>> {
	const api = client();
	if (!api) return {};
	const entries = await api.state.get.query({ keys });
	const parsed: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(entries)) {
		if (!entry) continue;
		try {
			parsed[key] = JSON.parse(entry.value);
		} catch {
			// Half-written or foreign - skip it this round.
		}
	}
	return parsed;
}

/** Mount once (the Odin shell): mirrors while sessions run on a server. */ export function useStateMirror(): void {
	useEffect(() => {
		const unsubscribers = [...storeByKey].map(([key, store]) =>
			store.subscribe(() => {
				if (adopting.has(key)) return;
				// Stamp every local edit, online or not: an offline edit still
				// wins over the server's older copy on the next connect.
				writeMeta({ ...readMeta(), [key]: Date.now() });
				if (getRemoteCoreTarget()) schedulePush(key);
			}),
		);
		const runSync = () => {
			sync().catch((error) =>
				console.warn("[state-mirror] sync failed:", error),
			);
		};
		const stopTarget = onRemoteCoreTargetChange(() => {
			// A different server (or a restarted one) gets every key again.
			lastPushed.clear();
			runSync();
		});
		const timer = setInterval(runSync, PULL_EVERY_MS);
		runSync();
		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
			stopTarget();
			clearInterval(timer);
		};
	}, []);
}
