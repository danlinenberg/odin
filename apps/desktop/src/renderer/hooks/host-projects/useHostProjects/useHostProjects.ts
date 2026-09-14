import { getEventBus } from "@odin/workspace-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { getHostServiceWsToken } from "renderer/lib/host-service-auth";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import {
	applyProjectChangedEvent,
	HOST_PROJECTS_QUERY_KEY,
	type HostProjectRow,
	normalizeHostProjectRow,
} from "./useHostProjects.utils";

export type { HostProjectRow } from "./useHostProjects.utils";

const PROJECTS_FALLBACK_REFETCH_INTERVAL_MS = 30_000;

export interface UseHostProjectsResult {
	projects: HostProjectRow[];
	/**
	 * True once the host answered or failed. Gates empty states only —
	 * existing rows always render (cache-first rule).
	 */
	isReady: boolean;
}

/**
 * The project read path: `project.list` on the local host service,
 * live-updated from its `project:changed` events.
 */
export function useHostProjects(): UseHostProjectsResult {
	const queryClient = useQueryClient();
	const { activeHostUrl } = useLocalHostService();

	const query = useQuery({
		queryKey: HOST_PROJECTS_QUERY_KEY,
		enabled: activeHostUrl !== null,
		refetchInterval: PROJECTS_FALLBACK_REFETCH_INTERVAL_MS,
		// The host is reachable at 127.0.0.1 even with the machine offline —
		// the default "online" networkMode would pause these queries the moment
		// navigator.onLine goes false, defeating offline-first entirely.
		networkMode: "always" as const,
		refetchIntervalInBackground: true,
		retry: 1,
		queryFn: async (): Promise<HostProjectRow[]> => {
			if (!activeHostUrl) return [];
			const client = getHostServiceClientByUrl(activeHostUrl);
			const rows = (await client.project.list.query()) as Array<
				Partial<HostProjectRow> & { id: string; repoPath: string }
			>;
			return rows.map(normalizeHostProjectRow);
		},
	});

	// Live updates: project:changed patches the cached list without a refetch.
	useEffect(() => {
		if (!activeHostUrl) return;
		const bus = getEventBus(activeHostUrl, () =>
			getHostServiceWsToken(activeHostUrl),
		);
		const removeListener = bus.on(
			"project:changed",
			"*",
			(projectId, event) => {
				queryClient.setQueryData<HostProjectRow[] | undefined>(
					HOST_PROJECTS_QUERY_KEY,
					(rows) => applyProjectChangedEvent(rows, event, projectId),
				);
			},
		);
		const releaseBus = bus.retain();
		return () => {
			removeListener();
			releaseBus();
		};
	}, [activeHostUrl, queryClient]);

	return {
		projects: query.data ?? [],
		isReady: query.isSuccess || query.isError,
	};
}
