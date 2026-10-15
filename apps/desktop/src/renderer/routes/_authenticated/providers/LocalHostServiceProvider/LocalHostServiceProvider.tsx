import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
} from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	setClientMachineId,
	setHostServiceSecret,
} from "renderer/lib/host-service-auth";
import type { HostServiceAvailabilityStatus } from "renderer/lib/host-service-unavailable";
import {
	onRemoteCoreTargetChange,
	setRemoteCoreTarget,
} from "renderer/lib/remote-core-link";
import { LOCAL_ORG_ID } from "shared/constants";

interface LocalHostServiceContextValue {
	machineId: string;
	activeHostUrl: string | null;
	activeOrganizationId: string;
	hostServiceStatus: HostServiceAvailabilityStatus;
	/**
	 * Resolve once the local host service is live, returning its loopback URL
	 * (or null on timeout). Use this at the point of a host-backed action so
	 * local-first UI can act immediately without gating on `activeHostUrl`.
	 */
	waitForHostReady: (timeoutMs?: number) => Promise<string | null>;
}

const LocalHostServiceContext =
	createContext<LocalHostServiceContextValue | null>(null);

export function LocalHostServiceProvider({
	children,
}: {
	children: ReactNode;
}) {
	const utils = electronTrpc.useUtils();

	const { data: machineIdData } = electronTrpc.device.getMachineId.useQuery(
		undefined,
		{ staleTime: Number.POSITIVE_INFINITY },
	);

	useEffect(() => {
		if (machineIdData?.machineId) {
			setClientMachineId(machineIdData.machineId);
		}
	}, [machineIdData]);

	const { data: activeConnection } =
		electronTrpc.hostServiceCoordinator.getConnection.useQuery(
			{ organizationId: LOCAL_ORG_ID },
			{ refetchInterval: 5_000 },
		);

	const { data: processStatus } =
		electronTrpc.hostServiceCoordinator.getProcessStatus.useQuery(
			{ organizationId: LOCAL_ORG_ID },
			{ refetchInterval: activeConnection?.port ? false : 1_000 },
		);

	// When a remote backend is connected, the renderer talks to it over an SSH
	// tunnel whose near end is a loopback port - so the host URL is still
	// `http://127.0.0.1:<port>` and bearer/WS auth is unchanged. A connected
	// remote takes precedence over the local host-service.
	const { data: activeRemote } =
		electronTrpc.remoteConnections.getActive.useQuery(undefined, {
			refetchInterval: 5_000,
		});

	const { data: remoteMode } =
		electronTrpc.remoteConnections.isRemoteMode.useQuery(undefined, {
			refetchInterval: 5_000,
		});

	electronTrpc.remoteConnections.onStatusChange.useSubscription(undefined, {
		onData: () => {
			utils.remoteConnections.getActive.invalidate();
			utils.remoteConnections.isRemoteMode.invalidate();
		},
	});

	const remoteHostUrl =
		activeRemote?.status === "connected"
			? `http://127.0.0.1:${activeRemote.localPort}`
			: null;
	if (remoteHostUrl && activeRemote?.secret) {
		setHostServiceSecret(remoteHostUrl, activeRemote.secret);
	}
	// Connections run on the server in remote mode (renderer/lib/remote-core-link).
	setRemoteCoreTarget(
		// Undefined until main answers: the window's schedulers wait for it.
		remoteMode === undefined ? undefined : remoteMode === true,
		remoteHostUrl && activeRemote?.secret
			? { url: remoteHostUrl, secret: activeRemote.secret }
			: null,
	);
	useEffect(
		() =>
			onRemoteCoreTargetChange(() => {
				void utils.connections.invalidate();
				void utils.work.invalidate();
				void utils.slack.invalidate();
				void utils.notion.invalidate();
				void utils.backlogReview.invalidate();
				void utils.workLog.invalidate();
			}),
		[utils],
	);

	const waitForHostReady = useCallback(
		async (timeoutMs = 20_000): Promise<string | null> => {
			// Resolve the live host URL if a port is up, else null. Swallows
			// transient IPC/tRPC fetch failures so a poll error never rejects the
			// nullable contract callers rely on. A connected remote wins.
			const tryGetHostUrl = async (): Promise<string | null> => {
				try {
					const remote = await utils.remoteConnections.getActive.fetch();
					if (remote?.status === "connected") {
						const hostUrl = `http://127.0.0.1:${remote.localPort}`;
						if (remote.secret) setHostServiceSecret(hostUrl, remote.secret);
						return hostUrl;
					}
					const connection =
						await utils.hostServiceCoordinator.getConnection.fetch({
							organizationId: LOCAL_ORG_ID,
						});
					if (connection?.port) {
						const hostUrl = `http://127.0.0.1:${connection.port}`;
						if (connection.secret)
							setHostServiceSecret(hostUrl, connection.secret);
						return hostUrl;
					}
				} catch (error) {
					console.warn("[host-service] connection poll failed:", error);
				}
				return null;
			};
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const hostUrl = await tryGetHostUrl();
				if (hostUrl) return hostUrl;
				await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
			// Final check: the last start may have brought the host up during the
			// trailing sleep, after the deadline elapsed.
			return await tryGetHostUrl();
		},
		[utils],
	);

	const value = useMemo<LocalHostServiceContextValue | null>(() => {
		if (!machineIdData) return null;
		const machineId = machineIdData.machineId;

		// A connected remote backend replaces the local host-service entirely.
		if (remoteHostUrl) {
			return {
				machineId,
				activeHostUrl: remoteHostUrl,
				activeOrganizationId: LOCAL_ORG_ID,
				hostServiceStatus: "running",
				waitForHostReady,
			};
		}

		const hostServiceStatus: HostServiceAvailabilityStatus =
			activeConnection?.port != null
				? "running"
				: (processStatus?.status ?? "unknown");

		if (!activeConnection?.port) {
			return {
				machineId,
				activeHostUrl: null,
				activeOrganizationId: LOCAL_ORG_ID,
				hostServiceStatus,
				waitForHostReady,
			};
		}

		const activeHostUrl = `http://127.0.0.1:${activeConnection.port}`;
		if (activeConnection.secret) {
			setHostServiceSecret(activeHostUrl, activeConnection.secret);
		}

		return {
			machineId,
			activeHostUrl,
			activeOrganizationId: LOCAL_ORG_ID,
			hostServiceStatus,
			waitForHostReady,
		};
	}, [
		machineIdData,
		activeConnection,
		processStatus?.status,
		remoteHostUrl,
		waitForHostReady,
	]);

	if (!value) return null;

	return (
		<LocalHostServiceContext.Provider value={value}>
			{children}
		</LocalHostServiceContext.Provider>
	);
}

export function useLocalHostService(): LocalHostServiceContextValue {
	const context = useContext(LocalHostServiceContext);
	if (!context) {
		throw new Error(
			"useLocalHostService must be used within LocalHostServiceProvider",
		);
	}
	return context;
}
