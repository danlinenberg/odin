import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useDefaultV2TerminalPresets } from "./hooks/useDefaultV2TerminalPresets";

/**
 * Seeds the default v2 terminal presets and warms the local host's agent
 * config cache for Settings.
 */
export function AgentHooks() {
	const { activeHostUrl } = useLocalHostService();
	useDefaultV2TerminalPresets(activeHostUrl);
	return null;
}
