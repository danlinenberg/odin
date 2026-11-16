import { useEffect } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useOdinRules } from "renderer/stores/odin-rules";

/**
 * Sends the rules to main whenever they change: host sessions take their
 * rule hooks from there, the ones the host starts by itself included.
 */
export function useHostRulesSync() {
	useEffect(() => {
		const send = (rules: unknown[]) =>
			electronTrpcClient.remoteHost.setRules.mutate(rules).catch(() => {});
		send(useOdinRules.getState().rules);
		return useOdinRules.subscribe((state, prev) => {
			if (state.rules !== prev.rules) send(state.rules);
		});
	}, []);
}
