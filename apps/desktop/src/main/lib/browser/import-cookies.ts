import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	statSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { safeStorage, session } from "electron";
import { IN_APP_BROWSER_PARTITION } from "shared/constants";
import {
	readOdinConfig,
	updateOdinConfig,
} from "../../../lib/trpc/routers/odin-config";

const run = promisify(execFile);

/**
 * Chromium browsers on macOS, with the Keychain item that holds each one's
 * cookie key. Reading it shows macOS's own "allow access" prompt, so Odin only
 * reads it when you ask, then keeps it encrypted under Odin's own Keychain key.
 */
const BROWSERS = [
	{ name: "Arc", dir: "Arc/User Data", keychain: "Arc Safe Storage" },
	{ name: "Chrome", dir: "Google/Chrome", keychain: "Chrome Safe Storage" },
	{
		name: "Brave",
		dir: "BraveSoftware/Brave-Browser",
		keychain: "Brave Safe Storage",
	},
	{
		name: "Edge",
		dir: "Microsoft Edge",
		keychain: "Microsoft Edge Safe Storage",
	},
	{ name: "Chromium", dir: "Chromium", keychain: "Chromium Safe Storage" },
];

/** Seconds between 1601-01-01 (Chromium's epoch) and 1970-01-01. */
const WINDOWS_EPOCH_OFFSET = 11_644_473_600;

const SAME_SITE = {
	0: "no_restriction",
	1: "lax",
	2: "strict",
} as const;

export interface CookieRow {
	host_key: string;
	name: string;
	value: string;
	encrypted_value: Buffer;
	path: string;
	expires_utc: number;
	has_expires: number;
	is_secure: number;
	is_httponly: number;
	samesite: number;
}

export const cookieKey = (keychainPassword: string): Buffer =>
	pbkdf2Sync(keychainPassword, "saltysalt", 1003, 16, "sha1");

/**
 * A cookie's value: plain, or "v10" + AES-128-CBC. Since cookie DB version 24
 * the plaintext starts with a 32-byte SHA-256 of the host, which is dropped.
 */
export function decryptValue(
	row: Pick<CookieRow, "value" | "encrypted_value">,
	key: Buffer,
	dbVersion: number,
): string {
	if (row.value || row.encrypted_value.length === 0) return row.value;
	if (row.encrypted_value.subarray(0, 3).toString() !== "v10") return "";
	const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
	const plain = Buffer.concat([
		decipher.update(row.encrypted_value.subarray(3)),
		decipher.final(),
	]);
	return (dbVersion >= 24 ? plain.subarray(32) : plain).toString("utf8");
}

export function toCookie(
	row: CookieRow,
	value: string,
): Electron.CookiesSetDetails {
	const host = row.host_key.replace(/^\./, "");
	return {
		url: `${row.is_secure ? "https" : "http"}://${host}${row.path}`,
		name: row.name,
		value,
		// A leading dot means "this domain and its subdomains"; without one the
		// cookie belongs to the exact host, which Electron wants as no domain.
		domain: row.host_key.startsWith(".") ? row.host_key : undefined,
		path: row.path,
		secure: !!row.is_secure,
		httpOnly: !!row.is_httponly,
		expirationDate: row.has_expires
			? row.expires_utc / 1e6 - WINDOWS_EPOCH_OFFSET
			: undefined,
		sameSite:
			SAME_SITE[row.samesite as keyof typeof SAME_SITE] ?? "unspecified",
	};
}

// ponytail: the most recently written cookie DB is the browser profile in use;
// add a browser/profile picker if someone needs a different one.
function newestCookieDb() {
	const support = path.join(os.homedir(), "Library/Application Support");
	let newest: {
		browser: (typeof BROWSERS)[number];
		file: string;
		profile: string;
		mtime: number;
	} | null = null;
	for (const browser of BROWSERS) {
		const root = path.join(support, browser.dir);
		if (!existsSync(root)) continue;
		for (const profile of readdirSync(root)) {
			for (const file of [
				path.join(root, profile, "Cookies"),
				path.join(root, profile, "Network/Cookies"),
			]) {
				if (!existsSync(file)) continue;
				const mtime = statSync(file).mtimeMs;
				if (!newest || mtime > newest.mtime)
					newest = { browser, file, profile, mtime };
			}
		}
	}
	return newest;
}

type Browser = (typeof BROWSERS)[number];

function savedKeychainPassword(browser: Browser): string | null {
	const saved = readOdinConfig().cookieKeys?.[browser.keychain];
	if (!saved || !safeStorage.isEncryptionAvailable()) return null;
	try {
		return safeStorage.decryptString(Buffer.from(saved, "base64"));
	} catch {
		return null;
	}
}

async function askKeychainPassword(browser: Browser): Promise<string> {
	const { stdout } = await run(
		"security",
		["find-generic-password", "-w", "-s", browser.keychain],
		{ timeout: 60_000 },
	).catch(() => {
		throw new Error(
			`Couldn't read ${browser.name}'s cookie key from the Keychain.`,
		);
	});
	const password = stdout.trim();
	if (safeStorage.isEncryptionAvailable()) {
		updateOdinConfig({
			cookieKeys: {
				...readOdinConfig().cookieKeys,
				[browser.keychain]: safeStorage
					.encryptString(password)
					.toString("base64"),
			},
		});
	}
	return password;
}

/**
 * Copies the signed-in sessions of your everyday browser into the in-app
 * browser. Reads a copy of the cookie DB, since the browser keeps it locked.
 * `ask: false` never shows the Keychain prompt: it returns null instead when
 * Odin hasn't saved that browser's cookie key yet.
 */
export async function importBrowserCookies({ ask = true } = {}): Promise<{
	browser: string;
	profile: string;
	imported: number;
} | null> {
	if (process.platform !== "darwin") {
		throw new Error("Importing cookies works on macOS only.");
	}
	const source = newestCookieDb();
	if (!source) throw new Error("No Chrome, Arc, Brave or Edge profile found.");

	const password =
		savedKeychainPassword(source.browser) ??
		(ask ? await askKeychainPassword(source.browser) : null);
	if (password === null) return null;
	const key = cookieKey(password);

	const tmp = mkdtempSync(path.join(os.tmpdir(), "odin-cookies-"));
	try {
		const copy = path.join(tmp, "Cookies");
		copyFileSync(source.file, copy);
		const db = new Database(copy, { readonly: true });
		const dbVersion = Number(
			(
				db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
					| { value: string }
					| undefined
			)?.value ?? 0,
		);
		const rows = db
			.prepare(
				"SELECT host_key, name, value, encrypted_value, path, expires_utc, has_expires, is_secure, is_httponly, samesite FROM cookies",
			)
			.all() as CookieRow[];
		db.close();

		const now = Date.now() / 1000;
		const cookies = session.fromPartition(IN_APP_BROWSER_PARTITION).cookies;
		let imported = 0;
		for (const row of rows) {
			const cookie = toCookie(row, decryptValue(row, key, dbVersion));
			if (cookie.expirationDate && cookie.expirationDate < now) continue;
			// Electron refuses some cookies (partitioned, oddly scoped); skip them.
			await cookies.set(cookie).then(
				() => imported++,
				() => {},
			);
		}
		await cookies.flushStore();
		return {
			browser: source.browser.name,
			profile: source.profile,
			imported,
		};
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

let importedThisLaunch = false;

/**
 * The automatic import: the first time the in-app browser opens after Odin
 * starts. Silent - it runs only once you've imported by hand and Odin has the
 * cookie key saved. Before that it returns "offer", once ever, so the panel
 * can explain the import and let you start it; null otherwise.
 */
export async function importBrowserCookiesOnLaunch() {
	if (importedThisLaunch || process.platform !== "darwin") return null;
	importedThisLaunch = true;
	const result = await importBrowserCookies({ ask: false }).catch(() => null);
	if (result || readOdinConfig().cookieImportOffered || !newestCookieDb()) {
		return result;
	}
	updateOdinConfig({ cookieImportOffered: true });
	return "offer" as const;
}
