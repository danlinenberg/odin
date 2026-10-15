import type { AgentLifecycleEvent } from "shared/notification-types";

/** Lifecycle names host-service broadcasts (its map-event-type.ts). */
type HostEventType =
	| "Start"
	| "Stop"
	| "PermissionRequest"
	| "Failed"
	| "Attached"
	| "Detached";

/**
 * Host event names onto the desktop's, the way notify.sh's local path maps
 * them: a session starting reads as working, a session ending as stopped.
 */
export function toDesktopEventType(
	eventType: string,
): AgentLifecycleEvent["eventType"] | null {
	switch (eventType as HostEventType) {
		case "Start":
		case "Attached":
			return "Start";
		case "Stop":
		case "Detached":
			return "Stop";
		case "PermissionRequest":
			return "PermissionRequest";
		case "Failed":
			return "Failed";
		default:
			return null;
	}
}
