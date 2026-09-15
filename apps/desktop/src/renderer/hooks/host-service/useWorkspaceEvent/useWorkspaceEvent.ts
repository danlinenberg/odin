import {
	type AgentLifecyclePayload,
	type GitChangedPayload,
	getEventBus,
	type PortChangedPayload,
	type TerminalLifecyclePayload,
} from "@odin/workspace-client";
import type { FsWatchEvent } from "@odin/workspace-fs/client";
import { useEffect, useEffectEvent } from "react";
import { getHostServiceWsToken } from "renderer/lib/host-service-auth";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";

/** Subscribe to an event bus event for a workspace on the local host. */
export function useWorkspaceEvent(
	type: "git:changed",
	workspaceId: string,
	callback: (payload: GitChangedPayload) => void,
	enabled?: boolean,
): void;
export function useWorkspaceEvent(
	type: "fs:events",
	workspaceId: string,
	callback: (event: FsWatchEvent) => void,
	enabled?: boolean,
): void;
export function useWorkspaceEvent(
	type: "agent:lifecycle",
	workspaceId: string,
	callback: (payload: AgentLifecyclePayload) => void,
	enabled?: boolean,
): void;
export function useWorkspaceEvent(
	type: "terminal:lifecycle",
	workspaceId: string,
	callback: (payload: TerminalLifecyclePayload) => void,
	enabled?: boolean,
): void;
export function useWorkspaceEvent(
	type: "port:changed",
	workspaceId: string,
	callback: (payload: PortChangedPayload) => void,
	enabled?: boolean,
): void;
export function useWorkspaceEvent(
	type:
		| "git:changed"
		| "fs:events"
		| "agent:lifecycle"
		| "terminal:lifecycle"
		| "port:changed",
	workspaceId: string,
	callback:
		| ((event: FsWatchEvent) => void)
		| ((payload: GitChangedPayload) => void)
		| ((payload: AgentLifecyclePayload) => void)
		| ((payload: TerminalLifecyclePayload) => void)
		| ((payload: PortChangedPayload) => void),
	enabled = true,
): void {
	const { activeHostUrl: hostUrl } = useLocalHostService();
	const handler = useEffectEvent(callback);

	useEffect(() => {
		if (!enabled || !hostUrl) return;

		const bus = getEventBus(hostUrl, () => getHostServiceWsToken(hostUrl));
		const cleanups: Array<() => void> = [];

		if (type === "fs:events") {
			bus.watchFs(workspaceId);
			const removeListener = bus.on(
				"fs:events",
				workspaceId,
				(_wid, payload) => {
					for (const event of payload.events) {
						(handler as (event: FsWatchEvent) => void)(event);
					}
				},
			);
			cleanups.push(removeListener, () => bus.unwatchFs(workspaceId));
		} else if (type === "agent:lifecycle") {
			const removeListener = bus.on(
				"agent:lifecycle",
				workspaceId,
				(_wid, payload) => {
					(handler as (payload: AgentLifecyclePayload) => void)(payload);
				},
			);
			cleanups.push(removeListener);
		} else if (type === "terminal:lifecycle") {
			const removeListener = bus.on(
				"terminal:lifecycle",
				workspaceId,
				(_wid, payload) => {
					(handler as (payload: TerminalLifecyclePayload) => void)(payload);
				},
			);
			cleanups.push(removeListener);
		} else if (type === "port:changed") {
			const removeListener = bus.on(
				"port:changed",
				workspaceId,
				(_wid, payload) => {
					(handler as (payload: PortChangedPayload) => void)(payload);
				},
			);
			cleanups.push(removeListener);
		} else {
			const removeListener = bus.on(
				"git:changed",
				workspaceId,
				(_wid, payload) => {
					(handler as (payload: GitChangedPayload) => void)(payload);
				},
			);
			cleanups.push(removeListener);
		}

		cleanups.push(bus.retain());

		return () => {
			for (const cleanup of cleanups) {
				cleanup();
			}
		};
	}, [enabled, hostUrl, type, workspaceId]);
}
