interface NamedHost {
	name: string;
	instanceId: string;
}

/**
 * The host a session runs on, by the name its pane keeps (`odinRemote`): the
 * current host, or one picked before it - a session stays on the host it
 * started on when you pick another. No name, or a name Odin no longer
 * knows: the current host.
 */
export function hostByName<T extends NamedHost>(
	current: T | undefined,
	past: T[] | undefined,
	name: string | null | undefined,
): T | undefined {
	if (!name) return current;
	const named = (host: T) => (host.name || host.instanceId) === name;
	if (current && named(current)) return current;
	return past?.find(named) ?? current;
}

/**
 * The host as a session that ran there before reaches it: as the Linux user
 * it ran as. Profiles each have their own user on a shared instance, so a
 * session started under one profile and reconnected under another looked for
 * its tmux and transcript in the wrong home - the chat showed no reply while
 * Claude answered in the other one. A session that never ran, or ran on
 * another instance: the host as is.
 */
export function asLastRun<T extends { instanceId: string; user: string }>(
	host: T,
	last: { instanceId?: unknown; user?: unknown } | null | undefined,
): T {
	if (
		last?.instanceId !== host.instanceId ||
		typeof last.user !== "string" ||
		!last.user
	)
		return host;
	return { ...host, user: last.user };
}

/** Another instance in the cluster: where it is, and the login that set it up. */
export interface ClusterHost {
	instanceId: string;
	name: string;
	profile?: string;
	region?: string;
	adminUser?: string;
}

/**
 * Settings a host keeps for itself: sign-ins made on that one machine, AWS
 * profiles set up with its instance role, and the copies of tasks and
 * automations it runs with the Mac away. A cluster host has none of them,
 * so this computer's tokens go to it in their place.
 */
const MAIN_HOST_ONLY = [
	"githubHostSignIns",
	"jiraHostSignIn",
	"notionHostSignIn",
	"mcpHostSignIns",
	"awsProfiles",
	"awayTasks",
	"claudeSetupDropped",
] as const;

/**
 * A cluster host as a full host: the main host's settings (connectors,
 * GitHub accounts, Claude setup, Linux user) on its own instance.
 */
export function clusterMember<T extends NamedHost>(
	main: T,
	extra: ClusterHost,
): T {
	const member = { ...main } as Record<string, unknown>;
	for (const key of MAIN_HOST_ONLY) delete member[key];
	for (const [key, value] of Object.entries(extra))
		if (value !== undefined) member[key] = value;
	return member as T;
}
