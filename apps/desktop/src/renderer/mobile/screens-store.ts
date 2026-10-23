/**
 * Where the phone keeps the screens Odin sent it: IndexedDB, which holds the
 * bundle's MB where localStorage would run into its quota.
 */

/** Odin's latest screens: its app.js and app.css, as text. */
export type ScreensBundle = {
	version: string;
	native: number;
	js: string;
	css: string;
};

/** "bundle" is the screens; "trying", the version a launch is starting; "bad", one that never started. */
type Key = "bundle" | "trying" | "bad";

function db(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const open = indexedDB.open("odin-screens", 1);
		open.onupgradeneeded = () => open.result.createObjectStore("kv");
		open.onsuccess = () => resolve(open.result);
		open.onerror = () => reject(open.error);
	});
}

async function run<T>(
	mode: IDBTransactionMode,
	act: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
	const conn = await db();
	try {
		return await new Promise<T>((resolve, reject) => {
			const request = act(conn.transaction("kv", mode).objectStore("kv"));
			request.onsuccess = () => resolve(request.result as T);
			request.onerror = () => reject(request.error);
		});
	} finally {
		conn.close();
	}
}

export function storeGet(key: "bundle"): Promise<ScreensBundle | undefined>;
export function storeGet(key: "trying" | "bad"): Promise<string | undefined>;
export function storeGet(key: Key): Promise<unknown> {
	return run<unknown>("readonly", (store) => store.get(key));
}

export const storeSet = (key: Key, value: ScreensBundle | string) =>
	run<unknown>("readwrite", (store) => store.put(value, key));

export const storeDelete = (key: Key) =>
	run<unknown>("readwrite", (store) => store.delete(key));
