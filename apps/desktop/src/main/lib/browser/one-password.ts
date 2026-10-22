import { execWithShellEnv } from "lib/trpc/routers/workspaces/utils/shell-env";

/** Long enough for 1Password to show its own unlock prompt. */
const OP_TIMEOUT_MS = 60_000;

export interface OnePasswordLogin {
	username: string;
	password: string;
}

/** Where the CLI's setup lives: install it, then let the 1Password app sign it in. */
export const OP_SETUP_URL =
	"https://developer.1password.com/docs/cli/get-started/";

/**
 * Something the user sets up once before the key button can fill: the
 * renderer shows it with a button to OP_SETUP_URL.
 */
export class OnePasswordSetupError extends Error {}

/** An `op` failure, said as what to do about it. */
export function opError(error: unknown): Error {
	if ((error as NodeJS.ErrnoException).code === "ENOENT") {
		return new OnePasswordSetupError(
			"Install the 1Password CLI, then turn on 1Password → Settings → Developer → Integrate with 1Password CLI.",
		);
	}
	const message = `${(error as { stderr?: string }).stderr ?? ""} ${(error as Error).message ?? ""}`;
	if (/dismissed/i.test(message)) {
		return new Error("1Password wasn't unlocked - try the key again.");
	}
	if (
		/not currently signed in|no accounts? configured|signin|desktop app/i.test(
			message,
		)
	) {
		return new OnePasswordSetupError(
			"Turn on 1Password → Settings → Developer → Integrate with 1Password CLI, then try the key again.",
		);
	}
	return error instanceof Error ? error : new Error(String(error));
}

interface OpItemSummary {
	id: string;
	urls?: { href: string }[];
}

interface OpItem {
	fields?: { purpose?: string; value?: string }[];
}

const opJson = async <T>(args: string[]): Promise<T> => {
	// Through the shell's PATH: Odin opened from the Dock has macOS's minimal
	// one, which misses Homebrew's /opt/homebrew/bin/op.
	try {
		const { stdout } = await execWithShellEnv(
			"op",
			[...args, "--format", "json"],
			{ timeout: OP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
		);
		return JSON.parse(stdout) as T;
	} catch (error) {
		throw opError(error);
	}
};

export const siteMatches = (pageHost: string, href: string): boolean => {
	try {
		const host = new URL(href.includes("://") ? href : `https://${href}`)
			.hostname;
		return pageHost === host || pageHost.endsWith(`.${host}`);
	} catch {
		return false;
	}
};

export async function findOnePasswordLogin(
	pageUrl: string,
): Promise<OnePasswordLogin | null> {
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
