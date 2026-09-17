import { describe, expect, it } from "bun:test";
import { mapEventType } from "./map-event-type";

describe("mapEventType", () => {
	// The bug this guards: Needs you sat at zero all day. Odin launches Claude
	// with --dangerously-skip-permissions, so the PermissionRequest hook never
	// fires — PreToolUse on a blocking tool and StopFailure are the two events
	// that still do, and StopFailure used to map to null and get dropped.
	it("routes a blocking tool call to Needs you", () => {
		expect(mapEventType("PreToolUse")).toBe("PermissionRequest");
	});

	it("maps StopFailure to the failed status instead of dropping it", () => {
		expect(mapEventType("StopFailure")).toBe("Failed");
	});

	// StopFailure is the *alternative* to Stop, so it must not read as one —
	// that would land an API-error session in Done.
	it("keeps a clean stop out of the failed bucket", () => {
		expect(mapEventType("Stop")).toBe("Stop");
	});

	it("drops an event it doesn't know", () => {
		expect(mapEventType("PreCompact")).toBeNull();
		expect(mapEventType(undefined)).toBeNull();
	});
});
