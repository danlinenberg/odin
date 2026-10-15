/**
 * Workspace Runtime Registry
 *
 * Process-scoped registry for workspace runtime providers.
 * The registry is cached for the lifetime of the process.
 *
 * Current behavior:
 * - All workspaces use the LocalWorkspaceRuntime
 * - The runtime is selected once based on settings (requires restart to change)
 *
 * Future behavior (cloud readiness):
 * - Per-workspace selection based on workspace metadata (cloudWorkspaceId, etc.)
 * - Local + cloud workspaces can coexist
 */

import { LocalWorkspaceRuntime } from "./local";
import type { RemoteTerminalRuntime } from "./remote";
import { RoutingWorkspaceRuntime } from "./routing";
import type { WorkspaceRuntime, WorkspaceRuntimeRegistry } from "./types";

// =============================================================================
// Registry Implementation
// =============================================================================

/**
 * Default registry implementation.
 *
 * Returns one RoutingWorkspaceRuntime for all workspaces: it runs sessions on
 * the laptop, or on the connected remote server (see routing.ts).
 */
class DefaultWorkspaceRuntimeRegistry implements WorkspaceRuntimeRegistry {
	private runtime: RoutingWorkspaceRuntime | null = null;

	/** Every workspace shares the routing runtime; it picks per pane. */
	getForWorkspaceId(_workspaceId: string): WorkspaceRuntime {
		return this.getDefault();
	}

	/**
	 * Get the default runtime (for global/legacy endpoints).
	 *
	 * Lazily initialized and cached for the lifetime of the process, so event
	 * wiring stays on one instance.
	 */
	getDefault(): RoutingWorkspaceRuntime {
		if (!this.runtime) {
			this.runtime = new RoutingWorkspaceRuntime(new LocalWorkspaceRuntime());
		}
		return this.runtime;
	}
}

// =============================================================================
// Singleton Instance
// =============================================================================

let registryInstance: DefaultWorkspaceRuntimeRegistry | null = null;

/**
 * Get the workspace runtime registry.
 *
 * The registry is process-scoped and cached. Callers should capture it once
 * (e.g., when creating a tRPC router) and use it for the lifetime of the router.
 *
 * This design allows:
 * 1. Stable runtime instances (no re-creation on each call)
 * 2. Consistent event wiring (same backend for all listeners)
 * 3. Future per-workspace selection (local vs cloud)
 */
export function getWorkspaceRuntimeRegistry(): WorkspaceRuntimeRegistry {
	if (!registryInstance) {
		registryInstance = new DefaultWorkspaceRuntimeRegistry();
	}
	return registryInstance;
}

/** The remote half of the default runtime: sessions run on the connected server. */
export function getRemoteTerminalRuntime(): RemoteTerminalRuntime {
	if (!registryInstance) {
		registryInstance = new DefaultWorkspaceRuntimeRegistry();
	}
	return registryInstance.getDefault().terminal.remote;
}

/**
 * Reset the registry (for testing only).
 * This should not be called in production code.
 */
export function resetWorkspaceRuntimeRegistry(): void {
	registryInstance = null;
}
