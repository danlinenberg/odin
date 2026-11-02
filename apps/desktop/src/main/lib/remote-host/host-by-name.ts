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
