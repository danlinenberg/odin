import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseIni } from "lib/trpc/routers/terminal/aws-sso";

/**
 * imagen-core's AWS guard lets Claude into its prod account only through a
 * profile with the read-only role, so a session on `--profile prod` (a
 * developer role) is blocked until the user adds one by hand. Odin adds it:
 * next to the first SSO profile that signs in to that account with another
 * role, a `<name>-readonly` profile with the same SSO sign-in and the
 * read-only role. Same sign-in, so no new login. Only appends; nothing the
 * user wrote changes.
 */

interface GuardConfig {
	prod_account_id?: string;
	readonly_role?: string;
}

/** The guard's settings from the newest installed imagen-core; null without one. */
export function imagenGuardConfig(home = homedir()): GuardConfig | null {
	const cache = join(home, ".claude", "plugins", "cache");
	let newest: { path: string; at: number } | null = null;
	const list = (dir: string) => {
		try {
			return readdirSync(dir);
		} catch {
			return [];
		}
	};
	for (const market of list(cache))
		for (const version of list(join(cache, market, "imagen-core"))) {
			const path = join(
				cache,
				market,
				"imagen-core",
				version,
				"hooks",
				"aws-guard.json",
			);
			try {
				const at = statSync(path).mtimeMs;
				if (!newest || at > newest.at) newest = { path, at };
			} catch {}
		}
	if (!newest) return null;
	try {
		const cfg = JSON.parse(readFileSync(newest.path, "utf8"));
		return cfg && typeof cfg === "object" ? cfg : null;
	} catch {
		return null;
	}
}

/** The section to append to the AWS config, or null when none is needed. */
export function readonlyProfileSection(
	configText: string,
	accountId: string,
	role: string,
): string | null {
	const sections = parseIni(configText);
	const profiles = Object.entries(sections).filter(
		([h]) => h === "default" || h.startsWith("profile "),
	);
	const inAccount = profiles.filter(
		([, p]) => p.sso_account_id === accountId && p.sso_role_name,
	);
	if (inAccount.some(([, p]) => p.sso_role_name === role)) return null;
	const source = inAccount.find(
		([, p]) => p.sso_session || (p.sso_start_url && p.sso_region),
	);
	if (!source) return null;
	const [header, p] = source;
	const name = `${header === "default" ? "default" : header.slice(8)}-readonly`;
	if (sections[`profile ${name}`]) return null;
	const lines = [
		`[profile ${name}]`,
		...(p.sso_session
			? [`sso_session = ${p.sso_session}`]
			: [`sso_start_url = ${p.sso_start_url}`, `sso_region = ${p.sso_region}`]),
		`sso_account_id = ${accountId}`,
		`sso_role_name = ${role}`,
		...(p.region ? [`region = ${p.region}`] : []),
	];
	return `\n# Added by Odin: read-only twin of [${header}], for imagen-core's AWS guard\n${lines.join("\n")}\n`;
}

export function ensureAwsReadonlyProfile(home = homedir()): void {
	const guard = imagenGuardConfig(home);
	if (!guard?.prod_account_id) return;
	const path = process.env.AWS_CONFIG_FILE || join(home, ".aws", "config");
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return;
	}
	const section = readonlyProfileSection(
		text,
		guard.prod_account_id,
		guard.readonly_role || "ReadOnlyAccess",
	);
	if (section) appendFileSync(path, section);
}
