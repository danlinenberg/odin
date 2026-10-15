import { remoteConnections } from "@odin/local-db";
import { eq } from "drizzle-orm";
import { safeStorage } from "electron";
import { localDb } from "../local-db";
import type { RemoteAuthMethod, RemoteConnectionConfig } from "./types";

export type RemoteConnectionRow = typeof remoteConnections.$inferSelect;

export function decryptPassword(encrypted: string | null): string | null {
	if (!encrypted) return null;
	try {
		return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
	} catch {
		return null;
	}
}

export function toConfig(row: RemoteConnectionRow): RemoteConnectionConfig {
	return {
		id: row.id,
		name: row.name,
		host: row.host,
		sshPort: row.sshPort,
		username: row.username,
		authMethod: row.authMethod as RemoteAuthMethod,
		sshKeyPath: row.sshKeyPath,
		password: decryptPassword(row.passwordEncrypted),
		odinFolder: row.odinFolder,
		remoteHostServicePort: row.remoteHostServicePort,
	};
}

/** The connection the user last chose to run on, if they never disconnected. */
export function getActiveConnectionRow(): RemoteConnectionRow | null {
	return (
		localDb
			.select()
			.from(remoteConnections)
			.where(eq(remoteConnections.isActive, true))
			.get() ?? null
	);
}
