import type { OdinFileConfig } from "lib/trpc/routers/odin-config";
import { githubAccessToken, githubTokenForLogin } from "../github-token";

/**
 * Which connected GitHub accounts may go to the remote host (Settings →
 * Sessions → Remote host → GitHub accounts on the host). A token on the host
 * is a token anyone with a shell on the instance can read, and a user token
 * reaches every repo its account can, so each account is a switch of its own.
 * Unset, the main connection alone goes, as it did before the switches
 * existed; the first flip writes the list out.
 */
export type Config = Pick<
	OdinFileConfig,
	"githubLogin" | "githubAccounts" | "remoteHost"
>;

export interface HostGithubAccount {
	login: string;
	/** Its token goes to the host, with a session and as the GitHub connector. */
	onHost: boolean;
	/** The main connection - the one Odin's own GitHub panes use. */
	main: boolean;
	/**
	 * The host has a sign-in of its own for it (github-host-login), which it
	 * refreshes itself; without one it gets this computer's token, sent again
	 * whenever this computer refreshes it.
	 */
	hostSignIn: boolean;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Every connected account with a known login, the main connection first. */
export function hostGithubAccounts(config: Config): HostGithubAccount[] {
	const allowed =
		config.remoteHost?.githubOnHost ??
		(config.githubLogin ? [config.githubLogin] : []);
	const signedIn = config.remoteHost?.githubHostSignIns ?? [];
	const logins = [
		...(config.githubLogin ? [config.githubLogin] : []),
		...(config.githubAccounts ?? []).map((account) => account.login),
	];
	return logins
		.filter((login, i) => logins.findIndex((l) => same(l, login)) === i)
		.map((login) => ({
			login,
			onHost: allowed.some((l) => same(l, login)),
			main: !!config.githubLogin && same(login, config.githubLogin),
			hostSignIn: signedIn.some((l) => same(l, login)),
		}));
}

/**
 * The account whose token a session on the host gets: the one that owns the
 * repo it works on when that account may go, else the main connection, else
 * the first that may. Null when none may.
 */
export function hostGithubLogin(
	config: Config,
	owner: string | null = null,
): string | null {
	const allowed = hostGithubAccounts(config).filter((a) => a.onHost);
	const owning = owner && allowed.find((a) => same(a.login, owner));
	return (owning || allowed.find((a) => a.main) || allowed[0])?.login ?? null;
}

/**
 * A repo that stays on this computer: one owned by a connected account that is
 * kept off the host. A session there could neither push it nor open its PR,
 * and the account is kept off the host on purpose.
 */
export function repoStaysLocal(config: Config, owner: string | null): boolean {
	if (!owner) return false;
	return hostGithubAccounts(config).some(
		(account) => !account.onHost && same(account.login, owner),
	);
}

/**
 * This computer's token for the host's default account (hostGithubLogin with
 * no owner), if any, good for at least `margin`: the copy the host falls
 * back on for an account without a sign-in of its own.
 */
export async function hostGithubToken(
	config: Config,
	owner: string | null = null,
	margin?: number,
): Promise<string | undefined> {
	const login = hostGithubLogin(config, owner);
	if (login) return (await githubTokenForLogin(login, margin)) ?? undefined;
	// A main connection from before logins were cached, with no choice made
	// yet: the only account there is, and the one that always went.
	if (config.remoteHost?.githubOnHost === undefined && !config.githubLogin)
		return (await githubAccessToken(margin)) ?? undefined;
	return undefined;
}

/**
 * This computer's token for every account allowed on the host, by login in
 * lower case (the host service compares logins without case), good for at
 * least `margin`.
 */
export async function hostGithubTokens(
	config: Config,
	margin?: number,
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const account of hostGithubAccounts(config)) {
		if (!account.onHost) continue;
		const token = await githubTokenForLogin(account.login, margin);
		if (token) out[account.login.toLowerCase()] = token;
	}
	return out;
}
