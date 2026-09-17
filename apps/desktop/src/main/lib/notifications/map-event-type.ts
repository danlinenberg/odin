export function mapEventType(
	eventType: string | undefined,
): "Start" | "Stop" | "PermissionRequest" | "Failed" | null {
	if (!eventType) {
		return null;
	}
	if (
		eventType === "Start" ||
		eventType === "SessionStart" ||
		eventType === "UserPromptSubmit" ||
		eventType === "PostToolUse" ||
		eventType === "PostToolUseFailure" ||
		eventType === "BeforeAgent" ||
		eventType === "AfterTool" ||
		eventType === "sessionStart" ||
		eventType === "session_start" ||
		eventType === "userPromptSubmitted" ||
		eventType === "user_prompt_submit" ||
		eventType === "postToolUse" ||
		eventType === "post_tool_use" ||
		eventType === "task_started"
	) {
		return "Start";
	}
	if (
		eventType === "PermissionRequest" ||
		eventType === "Notification" ||
		eventType === "PreToolUse" ||
		eventType === "preToolUse" ||
		eventType === "pre_tool_use" ||
		eventType === "exec_approval_request" ||
		eventType === "apply_patch_approval_request" ||
		eventType === "request_user_input"
	) {
		return "PermissionRequest";
	}
	// Claude/Kimi/Grok all register StopFailure — the turn ended on an API
	// error, with the session still alive — and this returned null for it, so
	// every one of those was dropped on the floor and the pane kept whatever
	// status it had. That's the only writer of the "failed" status there is.
	if (eventType === "StopFailure") {
		return "Failed";
	}
	if (
		eventType === "Stop" ||
		eventType === "stop" ||
		eventType === "agent-turn-complete" ||
		eventType === "AfterAgent" ||
		eventType === "sessionEnd" ||
		eventType === "session_end" ||
		eventType === "task_complete"
	) {
		return "Stop";
	}
	return null;
}
