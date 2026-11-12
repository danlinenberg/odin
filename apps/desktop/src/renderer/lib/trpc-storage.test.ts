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
