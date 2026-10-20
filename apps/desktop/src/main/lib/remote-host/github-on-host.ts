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
type Config = Pick<
	OdinFileConfig,
	"githubLogin" | "githubAccounts" | "remoteHost"
>;

export interface HostGithubAccount {
	login: string;
	/** Its token goes to the host, with a session and as the GitHub connector. */
	onHost: boolean;
	/** The main connection - the one Odin's own GitHub panes use. */
	main: boolean;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Every connected account with a known login, the main connection first. */
export function hostGithubAccounts(config: Config): HostGithubAccount[] {
	const allowed =
		config.remoteHost?.githubOnHost ??
		(config.githubLogin ? [config.githubLogin] : []);
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

/** The token that goes to the host for a session on `owner`'s repo, if any. */
export async function hostGithubToken(
	config: Config,
	owner: string | null = null,
): Promise<string | undefined> {
	const login = hostGithubLogin(config, owner);
	if (login) return (await githubTokenForLogin(login)) ?? undefined;
	// A main connection from before logins were cached, with no choice made
	// yet: the only account there is, and the one that always went.
	if (config.remoteHost?.githubOnHost === undefined && !config.githubLogin)
		return (await githubAccessToken()) ?? undefined;
	return undefined;
}
