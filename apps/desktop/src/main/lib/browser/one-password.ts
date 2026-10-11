import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Long enough for 1Password to show its own unlock prompt. */
const OP_TIMEOUT_MS = 60_000;

export interface OnePasswordLogin {
	username: string;
	password: string;
}

interface OpItemSummary {
	id: string;
	urls?: { href: string }[];
}

interface OpItem {
	fields?: { purpose?: string; value?: string }[];
}

class OpNotInstalledError extends Error {}

const opJson = async <T>(args: string[]): Promise<T> => {
	try {
		const { stdout } = await run("op", [...args, "--format", "json"], {
			timeout: OP_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
		});
		return JSON.parse(stdout) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new OpNotInstalledError();
		}
		throw error;
	}
};

// ponytail: host or parent-domain match only; no picker when several logins match.
export const siteMatches = (pageHost: string, href: string): boolean => {
	try {
		const host = new URL(href.includes("://") ? href : `https://${href}`)
			.hostname;
		return pageHost === host || pageHost.endsWith(`.${host}`);
	} catch {
		return false;
	}
};

/** "no-cli" when `op` isn't installed, so the UI can offer the setup guide. */
export async function findOnePasswordLogin(
	pageUrl: string,
): Promise<OnePasswordLogin | "no-cli" | null> {
	try {
		return await findLogin(pageUrl);
	} catch (error) {
		if (error instanceof OpNotInstalledError) return "no-cli";
		throw error;
	}
}

async function findLogin(pageUrl: string): Promise<OnePasswordLogin | null> {
	const pageHost = new URL(pageUrl).hostname;
	const items = await opJson<OpItemSummary[]>([
		"item",
		"list",
		"--categories",
		"Login",
	]);
	const match = items.find((item) =>
		item.urls?.some((url) => siteMatches(pageHost, url.href)),
	);
	if (!match) return null;

	const item = await opJson<OpItem>(["item", "get", match.id]);
	const fieldValue = (purpose: string) =>
		item.fields?.find((field) => field.purpose === purpose)?.value;
	const password = fieldValue("PASSWORD");
	if (!password) return null;
	return { username: fieldValue("USERNAME") ?? "", password };
}
