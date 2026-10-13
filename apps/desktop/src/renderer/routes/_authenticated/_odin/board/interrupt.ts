import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useTabsStore } from "renderer/stores/tabs/store";

/** Interrupt a session's turn: Ctrl+C into its PTY. */
export function interruptPane(paneId: string) {
	electronTrpcClient.terminal.write.mutate({ paneId, data: "\x03" });
	// Claude fires no Stop hook on an interrupt, so the card would read
	// Working until the scan - and a second click would land Ctrl+C at the
	// idle prompt and start quitting it. Same as Park.
	useTabsStore.setState((state) => ({
		panes: {
			...state.panes,
			[paneId]: { ...state.panes[paneId], status: "idle" },
		},
	}));
}
