import { existsSync } from "node:fs";
import { getWorkspaceTerminalContext } from "lib/trpc/routers/terminal/utils";
import { requireRemoteHostEndpoint } from "./host-client";
import { getRemoteConnectionManager } from "./remote-connection-manager";

/**
 * While sessions run on a server, the folders they run in are server paths.
 * The laptop cannot see them, so "does this exist?" and the session files
 * Odin writes there (task prompt, rule hook, attachments) go to the server.
 * A path that does exist on the laptop stays local: projects opened before
 * connecting keep working as they did.
 */
export function isServerPath(candidate: string | undefined | null): boolean {
	return (
		getRemoteConnectionManager().isRemoteMode() &&
		!!candidate &&
		!existsSync(candidate)
	);
}

/** Whether a desktop workspace's folder lives on the connected server. */
export function isRemoteWorkspace(workspaceId: string): boolean {
	if (!getRemoteConnectionManager().isRemoteMode()) return false;
	try {
		const { workspacePath } = getWorkspaceTerminalContext(workspaceId);
		return isServerPath(workspacePath);
	} catch {
		return false;
	}
}

export async function remotePathInfo(path: string): Promise<{
	exists: boolean;
	isDirectory: boolean;
	gitRoot: string | null;
}> {
	return requireRemoteHostEndpoint().client.remoteSessions.pathInfo.query({
		path,
	});
}

export async function remoteWriteFile(
	path: string,
	content: string | Uint8Array,
): Promise<void> {
	const bytes =
		typeof content === "string" ? Buffer.from(content, "utf8") : content;
	await requireRemoteHostEndpoint().client.remoteSessions.writeFile.mutate({
		path,
		contentBase64: Buffer.from(bytes).toString("base64"),
	});
}

export async function remoteMkdir(path: string): Promise<void> {
	await requireRemoteHostEndpoint().client.remoteSessions.mkdir.mutate({
		path,
	});
}
