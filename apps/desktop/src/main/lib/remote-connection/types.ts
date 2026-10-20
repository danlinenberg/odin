/** Lifecycle of a single remote backend connection. */
export type RemoteConnectionStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "error";

/**
 * The subset of a `remote_connections` row the manager needs to reach a host.
 * Credentials never live here beyond the path to an SSH key.
 */
export type RemoteAuthMethod = "key" | "password";

export interface RemoteConnectionConfig {
	id: string;
	name: string;
	host: string;
	sshPort: number;
	username: string;
	authMethod: RemoteAuthMethod;
	sshKeyPath: string | null;
	/** Decrypted password for `authMethod: "password"`; never persisted in clear. */
	password: string | null;
	odinFolder: string;
	remoteHostServicePort: number;
}

/** Structured result of a Test-connection probe, surfaced in Settings. */
export interface TestConnectionResult {
	ok: boolean;
	reachable: boolean;
	/** `uname -s` and `uname -m`, e.g. "Linux x86_64"; null when unreachable. */
	platform: string | null;
	folderReady: boolean;
	message: string;
}

/**
 * The currently active remote, from the renderer's point of view. `localPort`
 * is the near end of the SSH tunnel, so the host-service URL is always
 * `http://127.0.0.1:${localPort}` and bearer/WS auth works unchanged.
 */
export interface ActiveRemote {
	connectionId: string;
	name: string;
	host: string;
	localPort: number;
	secret: string;
	status: RemoteConnectionStatus;
}

/** Emitted whenever a connection's status changes. */
export interface RemoteConnectionStatusEvent {
	connectionId: string;
	name: string;
	host: string;
	status: RemoteConnectionStatus;
	localPort: number | null;
	error: string | null;
}
