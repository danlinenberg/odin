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
import { app, safeStorage, session } from "electron";
import { IN_APP_BROWSER_PARTITION } from "shared/constants";
import { LINK_HOSTS, type LinkSiteId } from "shared/in-odin-links";
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

/** Where a connection's site sends you to sign in, beside its own hosts. */
const SIGN_IN_HOSTS: Partial<Record<LinkSiteId, readonly string[]>> = {
	jira: ["atlassian.com"],
	notion: ["notion.com"],
};

/** The connections this profile is signed in to. */
export function connectedSites(): LinkSiteId[] {
	const config = readOdinConfig();
	const signedIn: Record<LinkSiteId, unknown> = {
		slack: config.slackToken,
		jira: config.jiraRefreshToken ?? config.jiraAccessToken,
		github: config.githubToken,
		notion: config.notionToken,
		gmail: config.gmailAddress,
		clickup: config.clickupToken,
	};
	return (Object.keys(signedIn) as LinkSiteId[]).filter((id) => signedIn[id]);
}

/**
 * The only sites whose cookies the in-app browser keeps: the connections
 * you are signed in to. Gmail's sign-in is Google's, which covers every
 * Google app. Cookies sit in the in-app browser where any process running as
 * you can read them - none for your bank, your mail or anything else.
 */
export function cookieDomains(connected = connectedSites()): string[] {
	return connected.flatMap((id) =>
		id === "gmail"
			? ["google.com"]
			: [...LINK_HOSTS[id], ...(SIGN_IN_HOSTS[id] ?? [])],
	);
}

export function isConnectionCookie(hostKey: string, domains: string[]) {
	const host = hostKey.replace(/^\./, "").toLowerCase();
	return domains.some(
		(domain) => host === domain || host.endsWith(`.${domain}`),
	);
}

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
	encrypted_value: Buffer | null;
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
	if (row.value || !row.encrypted_value?.length) return row.value;
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
export function newestCookieDb(home = os.homedir()) {
	const support = path.join(home, "Library/Application Support");
	let newest: {
		browser: (typeof BROWSERS)[number];
		file: string;
		profile: string;
		mtime: number;
	} | null = null;
	for (const browser of BROWSERS) {
		const root = path.join(support, browser.dir);
		if (!existsSync(root)) continue;
		for (const profile of readableDir(root)) {
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

// macOS walls off some apps' data (EPERM). Skip that browser, don't fail the import.
function readableDir(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
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
				"SELECT host_key, name, value, CAST(encrypted_value AS BLOB) AS encrypted_value, path, expires_utc, has_expires, is_secure, is_httponly, samesite FROM cookies",
			)
			.all() as CookieRow[];
		db.close();

		const now = Date.now() / 1000;
		const cookies = session.fromPartition(IN_APP_BROWSER_PARTITION).cookies;
		const domains = cookieDomains();
		let imported = 0;
		for (const row of rows) {
			if (!isConnectionCookie(row.host_key, domains)) continue;
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

/**
 * Removes the in-app browser's cookies for every site that is not a
 * connection's - an import used to copy all of them.
 */
export async function pruneOtherCookies(
	domains = cookieDomains(),
): Promise<number> {
	const cookies = session.fromPartition(IN_APP_BROWSER_PARTITION).cookies;
	let removed = 0;
	for (const cookie of await cookies.get({})) {
		if (!cookie.domain || isConnectionCookie(cookie.domain, domains)) continue;
		const host = cookie.domain.replace(/^\./, "");
		const url = `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`;
		await cookies.remove(url, cookie.name).then(
			() => removed++,
			() => {},
		);
	}
	if (removed) await cookies.flushStore();
	return removed;
}

/**
 * Writes every cookie again. The packaged app encrypts the cookie store, but
 * only on write: cookies saved before that stay in plain text until rewritten.
 */
async function rewriteCookies(): Promise<void> {
	const cookies = session.fromPartition(IN_APP_BROWSER_PARTITION).cookies;
	for (const cookie of await cookies.get({})) {
		if (!cookie.domain) continue;
		const host = cookie.domain.replace(/^\./, "");
		await cookies
			.set({
				url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`,
				name: cookie.name,
				value: cookie.value,
				domain: cookie.hostOnly ? undefined : cookie.domain,
				path: cookie.path,
				secure: cookie.secure,
				httpOnly: cookie.httpOnly,
				expirationDate: cookie.expirationDate,
				sameSite: cookie.sameSite,
			})
			.catch(() => {});
	}
	await cookies.flushStore();
}

/**
 * Whether this Electron encrypts cookies on disk. The packaged build always
 * does; a dev bundle does once patch-dev-protocol has set the fuse. A rewrite
 * without the fuse would stay plain text, so it waits for this.
 */
async function cookieFuseOn(): Promise<boolean> {
	if (app.isPackaged) return true;
	try {
		const { getCurrentFuseWire, FuseV1Options } = await import(
			"@electron/fuses"
		);
		// .../Odin Dev.app/Contents/MacOS/Electron -> the .app bundle.
		const bundle = process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, "");
		const wire = await getCurrentFuseWire(bundle);
		return wire[FuseV1Options.EnableCookieEncryption] === 49; // FuseState.ENABLE, which the package does not re-export;
	} catch {
		return false;
	}
}

let checkedThisLaunch = false;

/**
 * The first time the in-app browser opens after Odin starts: clears cookies
 * outside the connections, and returns "offer" once ever, so the panel can
 * explain the import and let you start it; null otherwise. It never imports
 * by itself - your browser's cookies come over only when you click Import.
 */
export async function importBrowserCookiesOnLaunch() {
	if (checkedThisLaunch) return null;
	checkedThisLaunch = true;
	await pruneOtherCookies().catch(() => 0);
	if (!readOdinConfig().cookiesEncrypted && (await cookieFuseOn())) {
		await rewriteCookies().catch(() => {});
		updateOdinConfig({ cookiesEncrypted: true });
	}
	if (
		process.platform !== "darwin" ||
		readOdinConfig().cookieImportOffered ||
		!newestCookieDb()
	) {
		return null;
	}
	updateOdinConfig({ cookieImportOffered: true });
	return "offer" as const;
}
