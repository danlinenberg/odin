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
