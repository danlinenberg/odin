import { expect, it, mock } from "bun:test";

mock.module("./trpc-client", () => ({ electronTrpcClient: {} }));

it("a reload inside the write debounce keeps the unsaved state", async () => {
	const store = new Map<string, string>();
	globalThis.localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	} as Storage;
	const listeners: Record<string, () => void> = {};
	globalThis.addEventListener = ((type: string, fn: () => void) => {
		listeners[type] = fn;
	}) as typeof addEventListener;

	const { createTrpcStorageAdapter } = await import("./trpc-storage");
	let saved: unknown = { tabs: ["with-card"] };
	const adapter = createTrpcStorageAdapter({
		get: async () => saved,
		set: async (input) => {
			saved = input;
		},
		writeDebounceMs: 300,
	});

	const doneState = JSON.stringify({ state: { tabs: [] }, version: 9 });
	await adapter.setItem("tabs", doneState);
	listeners.pagehide?.(); // reload before either debounce fired

	// The next page load's hydrate, while appState still has the old state.
	const fresh = createTrpcStorageAdapter({
		get: async () => ({ tabs: ["with-card"] }),
		set: async () => {},
	});
	expect(await fresh.getItem("tabs")).toBe(doneState);
});

it("changes that never pause still save within a few debounces", async () => {
	const { createTrpcStorageAdapter } = await import("./trpc-storage");
	const saved: unknown[] = [];
	const adapter = createTrpcStorageAdapter({
		get: async () => null,
		set: async (input) => void saved.push(input),
		writeDebounceMs: 20,
	});
	// A change every 10ms for 200ms: a plain debounce never fires.
	for (let i = 0; i < 20; i++) {
		await adapter.setItem("tabs", JSON.stringify({ state: { i }, version: 1 }));
		await new Promise((r) => setTimeout(r, 10));
	}
	expect(saved.length).toBeGreaterThan(1);
});

it("a save that never answers doesn't hold back the ones after it", async () => {
	const { createTrpcStorageAdapter } = await import("./trpc-storage");
	const saved: unknown[] = [];
	let calls = 0;
	const adapter = createTrpcStorageAdapter({
		get: async () => null,
		// The first call hangs for good, as a main process stuck on its write.
		set: (input) =>
			calls++ === 0
				? new Promise(() => {})
				: Promise.resolve(void saved.push(input)),
		saveTimeoutMs: 30,
		retryMs: 10,
	});
	await adapter.setItem(
		"tabs",
		JSON.stringify({ state: { i: 1 }, version: 1 }),
	);
	await new Promise((r) => setTimeout(r, 5));
	await adapter.setItem(
		"tabs",
		JSON.stringify({ state: { i: 2 }, version: 1 }),
	);
	await new Promise((r) => setTimeout(r, 120));
	expect(saved.at(-1)).toEqual({ i: 2 });
});

it("a failed save is tried again without another change", async () => {
	const { createTrpcStorageAdapter } = await import("./trpc-storage");
	const saved: unknown[] = [];
	let calls = 0;
	const adapter = createTrpcStorageAdapter({
		get: async () => null,
		set: async (input) => {
			if (calls++ === 0) throw new Error("main is busy");
			saved.push(input);
		},
		retryMs: 10,
	});
	await adapter.setItem(
		"tabs",
		JSON.stringify({ state: { i: 1 }, version: 1 }),
	);
	await new Promise((r) => setTimeout(r, 80));
	expect(saved).toEqual([{ i: 1 }]);
});

it("a full localStorage doesn't stop the save to the main process", async () => {
	const full = globalThis.localStorage;
	globalThis.localStorage = {
		getItem: () => null,
		setItem: () => {
			throw new Error("QuotaExceededError");
		},
		removeItem: () => {},
	} as unknown as Storage;
	try {
		const { createTrpcStorageAdapter } = await import("./trpc-storage");
		const saved: unknown[] = [];
		const adapter = createTrpcStorageAdapter({
			get: async () => null,
			set: async (input) => void saved.push(input),
		});
		await adapter.setItem(
			"tabs",
			JSON.stringify({ state: { i: 1 }, version: 1 }),
		);
		await new Promise((r) => setTimeout(r, 30));
		expect(saved).toEqual([{ i: 1 }]);
	} finally {
		globalThis.localStorage = full;
	}
});
