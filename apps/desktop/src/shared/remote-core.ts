/**
 * The tRPC namespaces that run on the server while sessions do: everything
 * that holds or uses a connection's credentials. Shared by the server router
 * and the renderer link that routes to it, so the two can't drift.
 */
export const REMOTE_CORE_NAMESPACES = [
	"connections",
	"work",
	"slack",
	"notion",
	"backlogReview",
	"workLog",
] as const;

/**
 * Single procedures of a namespace that otherwise stays on the laptop: Claude's
 * sign-in is about the machine sessions run on.
 */
export const REMOTE_CORE_PROCEDURES = [
	"system.claudeAuthStatus",
	"system.claudeLogin",
	"system.claudeLoginCode",
	"system.claudeLoginUrl",
] as const;

/** Mounted on the remote host-service beside its own /trpc. */
export const REMOTE_CORE_PATH = "/odin-trpc";

export function isRemoteCorePath(path: string): boolean {
	const namespace = path.split(".", 1)[0];
	return (
		(REMOTE_CORE_NAMESPACES as readonly string[]).includes(namespace) ||
		(REMOTE_CORE_PROCEDURES as readonly string[]).includes(path)
	);
}
