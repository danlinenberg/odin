import type { Client } from "@1password/sdk";
import { getDomain } from "tldts";
import {
	readOdinConfig,
	updateOdinConfig,
} from "../../../lib/trpc/routers/odin-config";

/**
 * Reaches the 1Password app you already have through 1Password's own SDK,
 * which loads a library that ships inside 1Password.app - no CLI. 1Password's
 * browser extension can't run here: Electron has no native messaging. The
 * first lookup per account shows 1Password's "allow Odin" prompt.
 */
const INTEGRATION = { integrationName: "Odin", integrationVersion: "1" };

/** Why the key button can't reach 1Password, so the panel can say what to do. */
export class OnePasswordSetupError extends Error {
	constructor(
		readonly reason: "no-account" | "not-connected",
		message: string,
	) {
		super(message);
	}
}

/** One login the page could take. No secrets: those load once you pick it. */
export interface OnePasswordMatch {
	account: string;
	vaultId: string;
	id: string;
	title: string;
}

export interface OnePasswordLogin {
	username: string;
	password: string;
	otp?: string;
}

const hostOf = (href: string): string | null => {
	try {
		return new URL(href.includes("://") ? href : `https://${href}`).hostname;
	} catch {
		return null;
	}
};

/**
 * How well a login saved for `href` fits the page: 2 for the same host or a
 * subdomain of it, 1 for the same site (cloud.getdbt.com's login on
 * auth.getdbt.com), 0 for another site. A site is the domain under its public
 * suffix, so two tenants of github.io or vercel.app never share a login.
 */
export const siteMatch = (pageHost: string, href: string): 0 | 1 | 2 => {
	const host = hostOf(href);
	if (!host) return 0;
	if (pageHost === host || pageHost.endsWith(`.${host}`)) return 2;
	const site = getDomain(host, { allowPrivateDomains: true });
	return site && site === getDomain(pageHost, { allowPrivateDomains: true })
		? 1
		: 0;
};

/** The 1Password accounts the key button searches, as named in 1Password's sidebar. */
export const onePasswordAccounts = (): string[] =>
	readOdinConfig().onePasswordAccounts ?? [];

export function setOnePasswordAccounts(accounts: string[]): string[] {
	const names = [
		...new Set(accounts.map((name) => name.trim()).filter(Boolean)),
	];
	updateOdinConfig({ onePasswordAccounts: names });
	clients.clear();
	return names;
}

/**
 * Vaults with no logins to fill whose items a business account can refuse to
 * list: the Transfer vault (items moved out of a departed member's vault)
 * and kinds this SDK doesn't know.
 */
const SKIPPED_VAULTS = new Set<string>(["transfer", "unsupported"]);

const clients = new Map<string, Promise<Client>>();

const notConnected = (account: string, cause: unknown) =>
	new OnePasswordSetupError(
		"not-connected",
		`Couldn't reach 1Password account "${account}". In 1Password, turn on Settings → Developer → Integrate with 1Password SDKs, and check the account name. (${cause instanceof Error ? cause.message : String(cause)})`,
	);

async function clientFor(account: string): Promise<Client> {
	let client = clients.get(account);
	if (!client) {
		client = import("@1password/sdk").then(({ createClient, DesktopAuth }) =>
			createClient({ auth: new DesktopAuth(account), ...INTEGRATION }),
		);
		clients.set(account, client);
	}
	try {
		return await client;
	} catch (error) {
		clients.delete(account);
		throw notConnected(account, error);
	}
}

/**
 * Every login for the page across your 1Password accounts (a work and a
 * personal one both count), the closest matches first.
 */
export async function findOnePasswordLogins(
	pageUrl: string,
): Promise<OnePasswordMatch[]> {
	const accounts = onePasswordAccounts();
	if (accounts.length === 0) {
		throw new OnePasswordSetupError(
			"no-account",
			"Which 1Password account should Odin use?",
		);
	}
	const pageHost = new URL(pageUrl).hostname;
	const perAccount = await Promise.all(
		accounts.map(async (account) => {
			const client = await clientFor(account);
			const vaults = (await client.vaults.list()).filter(
				(vault) => !SKIPPED_VAULTS.has(vault.vaultType),
			);
			const perVault = await Promise.allSettled(
				vaults.map((vault) => client.items.list(vault.id)),
			);
			const listed = perVault.flatMap((result) =>
				result.status === "fulfilled" ? [result.value] : [],
			);
			// A vault you can see but not read (a business account's shared
			// vaults can be set up that way) skips; only all of them failing is
			// an error.
			const [failed] = perVault.filter(
				(result) => result.status === "rejected",
			);
			if (!listed.length && failed) throw failed.reason;
			return listed.flat().flatMap((item) => {
				if (item.category !== "Login") return [];
				const score = Math.max(
					0,
					...item.websites.map((site) => siteMatch(pageHost, site.url)),
				);
				if (!score) return [];
				const match: OnePasswordMatch = {
					account,
					vaultId: item.vaultId,
					id: item.id,
					title: item.title,
				};
				return [{ match, score }];
			});
		}),
	);
	return perAccount
		.flat()
		.sort((a, b) => b.score - a.score)
		.map(({ match }) => match);
}

/** The picked login's username, password and current one-time code. */
export async function getOnePasswordLogin({
	account,
	vaultId,
	id,
}: Pick<
	OnePasswordMatch,
	"account" | "vaultId" | "id"
>): Promise<OnePasswordLogin | null> {
	const client = await clientFor(account);
	const item = await client.items.get(vaultId, id);
	const byId = (fieldId: string) =>
		item.fields.find((field) => field.id === fieldId)?.value;
	const password =
		byId("password") ??
		item.fields.find((field) => field.fieldType === "Concealed")?.value;
	if (!password) return null;
	const totp = item.fields.find((field) => field.fieldType === "Totp");
	const otp =
		totp?.details?.type === "Otp" ? totp.details.content.code : undefined;
	return { username: byId("username") ?? "", password, otp };
}
