import { EventEmitter } from "node:events";
import express from "express";
import { NOTIFICATION_EVENTS } from "shared/constants";
import { env } from "shared/env.shared";
import type { AgentLifecycleEvent } from "shared/notification-types";
import { HOOK_PROTOCOL_VERSION } from "../terminal/env";
import { mapEventType } from "./map-event-type";
import { resolvePaneId } from "./resolve-pane-id";

// Re-export types for backwards compatibility
export type {
	AgentLifecycleEvent,
	NotificationIds,
} from "shared/notification-types";
export { resolvePaneId } from "./resolve-pane-id";

/**
 * The environment this server is running in.
 * Used to validate incoming hook requests and detect cross-environment issues.
 */
const SERVER_ENV =
	env.NODE_ENV === "development" ? "development" : "production";
const debugHooksOverride = process.env.ODIN_DEBUG_HOOKS?.trim();
const DEBUG_HOOKS_ENABLED =
	debugHooksOverride === undefined
		? SERVER_ENV === "development"
		: !/^(0|false)$/i.test(debugHooksOverride);

/**
 * Broadcasts normalized agent lifecycle events from the local hook server.
 */
export const notificationsEmitter = new EventEmitter();

const app = express();

// Parse JSON request bodies
app.use(express.json());

// CORS
app.use((req, res, next) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	if (req.method === "OPTIONS") {
		return res.status(200).end();
	}
	next();
});

// Agent lifecycle hook
app.get("/hook/complete", (req, res) => {
	const {
		paneId,
		tabId,
		workspaceId,
		sessionId,
		terminalId,
		hookSessionId,
		resourceId,
		eventType,
		env: clientEnv,
		version,
	} = req.query;

	// Environment validation: detect dev/prod cross-talk
	// We still return success to not block the agent, but log a warning
	if (clientEnv && clientEnv !== SERVER_ENV) {
		console.warn(
			`[notifications] Environment mismatch: received ${clientEnv} request on ${SERVER_ENV} server. ` +
				`This may indicate a stale hook or misconfigured terminal. Ignoring request.`,
		);
		return res.json({ success: true, ignored: true, reason: "env_mismatch" });
	}

	// Log version for debugging (helpful when troubleshooting hook issues)
	if (version && version !== HOOK_PROTOCOL_VERSION) {
		console.log(
			`[notifications] Received hook v${version} request (server expects v${HOOK_PROTOCOL_VERSION})`,
		);
	}

	const mappedEventType = mapEventType(eventType as string | undefined);

	// Unknown or missing eventType: return success but don't process
	// This ensures forward compatibility and doesn't block the agent
	if (!mappedEventType) {
		if (eventType) {
			console.log("[notifications] Ignoring unknown eventType:", eventType);
		}
		return res.json({ success: true, ignored: true });
	}

	const resolvedPaneId = resolvePaneId(
		paneId as string | undefined,
		tabId as string | undefined,
		workspaceId as string | undefined,
		sessionId as string | undefined,
	);

	const event: AgentLifecycleEvent = {
		paneId: resolvedPaneId,
		tabId: tabId as string | undefined,
		workspaceId: workspaceId as string | undefined,
		terminalId: terminalId as string | undefined,
		eventType: mappedEventType,
	};

	if (DEBUG_HOOKS_ENABLED) {
		console.log("[notifications] hook event received", {
			eventType,
			mappedEventType,
			paneId: paneId as string | undefined,
			tabId: tabId as string | undefined,
			workspaceId: workspaceId as string | undefined,
			sessionId: sessionId as string | undefined,
			terminalId: terminalId as string | undefined,
			hookSessionId: hookSessionId as string | undefined,
			resourceId: resourceId as string | undefined,
			resolvedPaneId,
		});
	}

	notificationsEmitter.emit(NOTIFICATION_EVENTS.AGENT_LIFECYCLE, event);

	res.json({ success: true, paneId: resolvedPaneId, tabId });
});

// Health check
app.get("/health", (_req, res) => {
	res.json({ status: "ok" });
});

// 404
app.use((_req, res) => {
	res.status(404).json({ error: "Not found" });
});

/**
 * Exposes the notifications Express app for startup and tests.
 */
export const notificationsApp = app;
