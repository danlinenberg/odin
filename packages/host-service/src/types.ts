import type { Octokit } from "@octokit/rest";
import type { ChatService } from "@odin/chat-legacy/server/desktop";
import type { HostDb } from "./db";
import type { EventBus } from "./events";
import type { AcpSessionManager } from "./runtime/acp-sessions";
import type { ChatRuntimeManager } from "./runtime/chat";
import type { WorkspaceFilesystemManager } from "./runtime/filesystem";
import type { GitCredentialProvider, GitFactory } from "./runtime/git";
import type { PullRequestRuntimeManager } from "./runtime/pull-requests";
import type { TerminalAgentStore } from "./terminal-agents";
import type { ExecGh } from "./trpc/router/workspace-creation/utils/exec-gh";

export interface HostServiceRuntime {
	acpSessions: AcpSessionManager;
	/**
	 * Feature gate for the pre-release ACP session harness. Off by default;
	 * app.ts turns it on via ODIN_ACP_SESSIONS=1 (or a test-injected
	 * manager). When off, the acpSessions router rejects every call and the
	 * WS stream route is not registered.
	 */
	acpSessionsEnabled: boolean;
	auth: ChatService;
	chat: ChatRuntimeManager;
	filesystem: WorkspaceFilesystemManager;
	pullRequests: PullRequestRuntimeManager;
}

export interface HostServiceContext {
	git: GitFactory;
	credentials: GitCredentialProvider;
	github: () => Promise<Octokit>;
	execGh: ExecGh;
	db: HostDb;
	runtime: HostServiceRuntime;
	eventBus: EventBus;
	terminalAgentStore: TerminalAgentStore;
	organizationId: string;
	isAuthenticated: boolean;
	clientMachineId?: string;
}
