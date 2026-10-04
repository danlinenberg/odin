import { describe, expect, it } from "bun:test";
import type { AddressInfo } from "node:net";
import { NOTIFICATION_EVENTS } from "shared/constants";
import { mapEventType } from "./map-event-type";
import { resolvePaneId } from "./resolve-pane-id";
import { notificationsApp, notificationsEmitter } from "./server";

describe("notifications/server", () => {
	describe("resolvePaneId", () => {
		it("returns an explicit paneId even when app state is not initialized", () => {
			expect(resolvePaneId("pane-1", "tab-1", "ws-1", "session-1")).toBe(
				"pane-1",
			);
		});
	});

	describe("mapEventType", () => {
		it("should map 'Start' to 'Start'", () => {
			expect(mapEventType("Start")).toBe("Start");
		});

		it("should map 'SessionStart' to 'Start'", () => {
			expect(mapEventType("SessionStart")).toBe("Start");
		});

		it("should map 'UserPromptSubmit' to 'Start'", () => {
			expect(mapEventType("UserPromptSubmit")).toBe("Start");
		});

		it("should map Codex snake_case start events to 'Start'", () => {
			expect(mapEventType("session_start")).toBe("Start");
			expect(mapEventType("user_prompt_submit")).toBe("Start");
			expect(mapEventType("post_tool_use")).toBe("Start");
			expect(mapEventType("task_started")).toBe("Start");
		});

		it("should map 'Stop' to 'Stop'", () => {
			expect(mapEventType("Stop")).toBe("Stop");
		});

		it("should map 'agent-turn-complete' to 'Stop'", () => {
			expect(mapEventType("agent-turn-complete")).toBe("Stop");
		});

		it("should map Codex native stop events to 'Stop'", () => {
			expect(mapEventType("stop")).toBe("Stop");
			expect(mapEventType("task_complete")).toBe("Stop");
		});

		it("should map 'PostToolUse' to 'Start'", () => {
			expect(mapEventType("PostToolUse")).toBe("Start");
		});

		it("should map 'PostToolUseFailure' to 'Start'", () => {
			expect(mapEventType("PostToolUseFailure")).toBe("Start");
		});

		it("should map Gemini 'BeforeAgent' to 'Start'", () => {
			expect(mapEventType("BeforeAgent")).toBe("Start");
		});

		it("should map Gemini 'AfterAgent' to 'Stop'", () => {
			expect(mapEventType("AfterAgent")).toBe("Stop");
		});

		it("should map Gemini 'AfterTool' to 'Start'", () => {
			expect(mapEventType("AfterTool")).toBe("Start");
		});

		it("should map 'PermissionRequest' to 'PermissionRequest'", () => {
			expect(mapEventType("PermissionRequest")).toBe("PermissionRequest");
		});

		it("should map Codex tool approval events to 'PermissionRequest'", () => {
			expect(mapEventType("PreToolUse")).toBe("PermissionRequest");
			expect(mapEventType("pre_tool_use")).toBe("PermissionRequest");
			expect(mapEventType("exec_approval_request")).toBe("PermissionRequest");
			expect(mapEventType("apply_patch_approval_request")).toBe(
				"PermissionRequest",
			);
			expect(mapEventType("request_user_input")).toBe("PermissionRequest");
		});

		it("should map Factory Droid 'Notification' to 'PermissionRequest'", () => {
			expect(mapEventType("Notification")).toBe("PermissionRequest");
		});

		it("should return null for unknown event types (forward compatibility)", () => {
			expect(mapEventType("UnknownEvent")).toBeNull();
			expect(mapEventType("FutureEvent")).toBeNull();
			expect(mapEventType("SomeNewHook")).toBeNull();
		});

		it("should return null for undefined eventType (not default to Stop)", () => {
			expect(mapEventType(undefined)).toBeNull();
		});

		it("should return null for empty string eventType", () => {
			expect(mapEventType("")).toBeNull();
		});
	});

	// It runs commands on a port any web page can reach, so a browser is refused.
	describe("POST /shell/run", () => {
		const post = async (headers: Record<string, string> = {}) => {
			const server = notificationsApp.listen(0, "127.0.0.1");
			await new Promise((resolve) => server.once("listening", resolve));
			const seen: unknown[] = [];
			const listener = (request: unknown) => seen.push(request);
			notificationsEmitter.on(NOTIFICATION_EVENTS.RUN_IN_SHELL, listener);
			try {
				const { port } = server.address() as AddressInfo;
				const response = await fetch(`http://127.0.0.1:${port}/shell/run`, {
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						...headers,
					},
					body: "paneId=pane-1&command=cd+%2Ftmp+%26%26+bun+run+dev",
				});
				return { status: response.status, seen };
			} finally {
				notificationsEmitter.off(NOTIFICATION_EVENTS.RUN_IN_SHELL, listener);
				server.close();
			}
		};

		it("hands an agent's command to the window", async () => {
			const { status, seen } = await post();
			expect(status).toBe(200);
			expect(seen).toEqual([
				{ paneId: "pane-1", command: "cd /tmp && bun run dev" },
			]);
		});

		it("refuses anything a browser sent", async () => {
			const { status, seen } = await post({ origin: "https://evil.example" });
			expect(status).toBe(403);
			expect(seen).toEqual([]);
		});
	});
});
