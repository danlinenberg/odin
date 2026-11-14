import { createJSONStorage, type StateStorage } from "zustand/middleware";
import { electronTrpcClient } from "./trpc-client";

/**
 * Creates a Zustand storage adapter that uses tRPC for persistence.
 * This ensures all state is persisted through the centralized appState lowdb instance.
 */

interface TrpcStorageConfig {
	get: () => Promise<unknown>;
	set: (input: unknown) => Promise<unknown>;
	writeDebounceMs?: number;
	/** How long a save may take before it counts as failed. */
	saveTimeoutMs?: number;
	/** How long after a failed save the same state is sent again. */
	retryMs?: number;
}

const PENDING_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const LOCAL_SNAPSHOT_WRITE_DEBOUNCE_MS = 250;
/** A write waits at most this many debounces, however often state changes. */
const MAX_WAIT_DEBOUNCES = 3;
/**
 * A save the main process never answers (its write to disk stuck) used to
 * hold back every save after it: the window went on, and the main process,
 * which the phone, the tray and the remote host read, kept the board of that
 * moment for days. Past this, the save counts as failed and the next one goes.
 */
const SAVE_TIMEOUT_MS = 10_000;
/** A failed save is sent again this long after, with whatever is newest. */
const RETRY_MS = 5_000;

export function createTrpcStorageAdapter(
	config: TrpcStorageConfig,
): StateStorage {
	const debounceMs = config.writeDebounceMs ?? 0;
	const saveTimeoutMs = config.saveTimeoutMs ?? SAVE_TIMEOUT_MS;
	const retryMs = config.retryMs ?? RETRY_MS;
	let pendingValue: string | null = null;
	let lastFlushedValue: string | null = null;
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	/** When the oldest unsaved change came in. */
	let pendingSince = 0;
	let isFlushing = false;
	let pendingSnapshotValue: string | null = null;
	let pendingSnapshotTimer: ReturnType<typeof setTimeout> | null = null;

	const getPendingSnapshotKey = (name: string) => `${name}:pending`;
	const getPendingSnapshotUpdatedAtKey = (name: string) =>
		`${name}:pending:updatedAt`;
	const pendingSnapshotDebounceMs =
		debounceMs > 0
			? Math.min(debounceMs, LOCAL_SNAPSHOT_WRITE_DEBOUNCE_MS)
			: LOCAL_SNAPSHOT_WRITE_DEBOUNCE_MS;

	// A reload inside the write debounce (Done closing the drawer releases the
	// dev server's held full-reload that same instant) used to drop the change:
	// the page came back from the old appState, and a Done card came back with
	// it. localStorage is synchronous, so park the unsaved value there on the
	// way out - getItem already prefers a fresh pending snapshot.
	let storeName: string | null = null;
	globalThis.addEventListener?.("pagehide", () => {
		const unsaved = pendingValue ?? pendingSnapshotValue;
		if (!storeName || unsaved === null) return;
		try {
			localStorage.setItem(getPendingSnapshotKey(storeName), unsaved);
			localStorage.setItem(
				getPendingSnapshotUpdatedAtKey(storeName),
				String(Date.now()),
			);
		} catch {}
	});

	const clearPendingSnapshot = (name: string, expectedValue?: string): void => {
		try {
			const pendingKey = getPendingSnapshotKey(name);
			if (
				expectedValue !== undefined &&
				localStorage.getItem(pendingKey) !== expectedValue
			) {
				return;
			}
			localStorage.removeItem(pendingKey);
			localStorage.removeItem(getPendingSnapshotUpdatedAtKey(name));
		} catch (error) {
			console.error("[trpc-storage] Failed to clear pending snapshot:", error);
		}
	};

	const schedulePendingSnapshotPersist = (
		name: string,
		snapshot: string,
	): void => {
		pendingSnapshotValue = snapshot;

		if (pendingSnapshotTimer) {
			clearTimeout(pendingSnapshotTimer);
			pendingSnapshotTimer = null;
		}

		pendingSnapshotTimer = setTimeout(() => {
			pendingSnapshotTimer = null;
			const valueToPersist = pendingSnapshotValue;
			pendingSnapshotValue = null;
			if (!valueToPersist) return;

			try {
				localStorage.setItem(getPendingSnapshotKey(name), valueToPersist);
				localStorage.setItem(
					getPendingSnapshotUpdatedAtKey(name),
					String(Date.now()),
				);
			} catch (error) {
				console.error(
					"[trpc-storage] Failed to cache pending snapshot in localStorage:",
					error,
				);
			}
		}, pendingSnapshotDebounceMs);
	};

	const scheduleImmediateFlush = (name: string, snapshot: string): void => {
		// Ensure pending snapshot eventually syncs to appState.
		if (pendingValue === null) {
			pendingValue = snapshot;
		}
		if (!isFlushing && flushTimer === null) {
			flushTimer = setTimeout(() => {
				flushTimer = null;
				void flushPendingWrite(name);
			}, 0);
		}
	};

	const flushPendingWrite = async (name: string): Promise<void> => {
		if (isFlushing || pendingValue === null) return;
		const valueToFlush = pendingValue;
		pendingValue = null;

		if (valueToFlush === lastFlushedValue) {
			return;
		}

		isFlushing = true;
		let failed = false;
		try {
			const parsed = JSON.parse(valueToFlush) as {
				state: unknown;
				version: number;
			};
			// Persist version in localStorage, bare state via tRPC. A full
			// localStorage must not stop the save itself.
			try {
				localStorage.setItem(`${name}:version`, String(parsed.version));
			} catch (error) {
				console.error("[trpc-storage] Failed to keep the version:", error);
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					config.set(parsed.state),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error(`No answer in ${saveTimeoutMs}ms`)),
							saveTimeoutMs,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
			lastFlushedValue = valueToFlush;

			// Cancel delayed snapshot write if this exact snapshot was already flushed.
			if (pendingSnapshotValue === valueToFlush && pendingSnapshotTimer) {
				clearTimeout(pendingSnapshotTimer);
				pendingSnapshotTimer = null;
				pendingSnapshotValue = null;
			}
			clearPendingSnapshot(name, valueToFlush);
		} catch (error) {
			console.error("[trpc-storage] Failed to set state:", error);
			failed = true;
			// Still unsaved: it goes again, unless a newer state came meanwhile.
			if (pendingValue === null) pendingValue = valueToFlush;
		} finally {
			isFlushing = false;
			if (pendingValue !== null && flushTimer === null) {
				const wait = failed ? retryMs : debounceMs;
				if (wait > 0) {
					flushTimer = setTimeout(() => {
						flushTimer = null;
						void flushPendingWrite(name);
					}, wait);
				} else {
					void flushPendingWrite(name);
				}
			}
		}
	};

	return {
		getItem: async (name: string): Promise<string | null> => {
			try {
				const state = await config.get();
				const version = Number.parseInt(
					localStorage.getItem(`${name}:version`) ?? "0",
					10,
				);
				const canonicalSnapshot = state
					? JSON.stringify({ state, version })
					: null;

				const pendingSnapshot = localStorage.getItem(
					getPendingSnapshotKey(name),
				);
				const pendingUpdatedAt = Number.parseInt(
					localStorage.getItem(getPendingSnapshotUpdatedAtKey(name)) ?? "0",
					10,
				);
				const pendingAgeMs =
					Number.isFinite(pendingUpdatedAt) && pendingUpdatedAt > 0
						? Date.now() - pendingUpdatedAt
						: Number.POSITIVE_INFINITY;
				const isPendingFresh = pendingAgeMs <= PENDING_SNAPSHOT_TTL_MS;

				if (pendingSnapshot) {
					if (!canonicalSnapshot) {
						if (isPendingFresh) {
							scheduleImmediateFlush(name, pendingSnapshot);
							return pendingSnapshot;
						}
						clearPendingSnapshot(name);
						return null;
					}

					if (pendingSnapshot === canonicalSnapshot) {
						clearPendingSnapshot(name);
						return canonicalSnapshot;
					}

					// Only trust pending snapshots that are very recent; otherwise
					// canonical appState remains the source of truth.
					if (isPendingFresh) {
						scheduleImmediateFlush(name, pendingSnapshot);
						return pendingSnapshot;
					}

					clearPendingSnapshot(name);
					return canonicalSnapshot;
				}

				return canonicalSnapshot;
			} catch (error) {
				console.error("[trpc-storage] Failed to get state:", error);
				return null;
			}
		},
		setItem: async (name: string, value: string): Promise<void> => {
			if (value === pendingValue || value === lastFlushedValue) {
				return;
			}

			storeName = name;
			if (pendingValue === null) pendingSince = Date.now();
			pendingValue = value;
			schedulePendingSnapshotPersist(name, value);
			// Changes that never pause (a session starting) kept pushing the
			// write back, and the main process, which the phone asks, saw a new
			// pane seconds late. Past MAX_WAIT_DEBOUNCES, the timer set stays.
			if (
				flushTimer &&
				Date.now() - pendingSince >= debounceMs * MAX_WAIT_DEBOUNCES
			)
				return;
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}

			if (debounceMs > 0) {
				flushTimer = setTimeout(() => {
					flushTimer = null;
					void flushPendingWrite(name);
				}, debounceMs);
			} else {
				void flushPendingWrite(name);
			}
		},
		removeItem: async (_name: string): Promise<void> => {
			// Reset to empty/default state is handled by the store itself
			// No-op here as we don't want to delete persisted state
		},
	};
}

/**
 * Zustand storage adapter for tabs state using tRPC
 */
export const trpcTabsStorage = createJSONStorage(() =>
	createTrpcStorageAdapter({
		get: () => electronTrpcClient.uiState.tabs.get.query(),
		// biome-ignore lint/suspicious/noExplicitAny: Zustand persist passes unknown, tRPC expects typed input
		set: (input) => electronTrpcClient.uiState.tabs.set.mutate(input as any),
		writeDebounceMs: 300,
	}),
);

/**
 * Zustand storage adapter for theme state using tRPC
 */
export const trpcThemeStorage = createJSONStorage(() =>
	createTrpcStorageAdapter({
		get: () => electronTrpcClient.uiState.theme.get.query(),
		// biome-ignore lint/suspicious/noExplicitAny: Zustand persist passes unknown, tRPC expects typed input
		set: (input) => electronTrpcClient.uiState.theme.set.mutate(input as any),
	}),
);
