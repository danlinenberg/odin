import { toast } from "@odin/ui/sonner";
import { Switch } from "@odin/ui/switch";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	AUTO_START_HINTS,
	AUTO_START_SOURCES,
	type AutoStartSource,
} from "shared/auto-start";
import { SettingRow, SettingsSection } from "../../components/SettingsPage";

/**
 * Settings > Remote > Auto-start new tasks: one switch per source. While the
 * remote host is on, a new task from a source switched on starts a session
 * there by itself (renderer hooks/useRemoteAutoStart). Tasks already waiting
 * when a switch goes on are left alone.
 */
export function AutoStartSection() {
	const utils = electronTrpc.useUtils();
	const { data: remote } = electronTrpc.remoteHost.get.useQuery();
	const { data: sources } = electronTrpc.remoteHost.autoStart.useQuery();
	const setSources = electronTrpc.remoteHost.setAutoStart.useMutation({
		onSuccess: () => void utils.remoteHost.autoStart.invalidate(),
		onError: (error) => toast.error(error.message),
	});
	const host = remote?.host;
	const hostOn = Boolean(host?.on);
	const on = new Set(sources ?? []);
	const toggle = (source: AutoStartSource, next: boolean) => {
		const picked = AUTO_START_SOURCES.filter((s) =>
			s === source ? next : on.has(s),
		);
		setSources.mutate({ sources: picked });
	};

	return (
		<SettingsSection
			title="Auto-start new tasks"
			description={
				hostOn
					? `While sessions start on ${host?.name || host?.instanceId}, a new task from a source switched on starts a session there by itself - no click, no question. Tasks already waiting when you switch one on are left alone.`
					: "Works while sessions start on a remote host: set one up above and turn it on. Then a new task from a source switched on here starts a session there by itself."
			}
		>
			{AUTO_START_SOURCES.map((source) => (
				<SettingRow
					key={source}
					label={source}
					htmlFor={`auto-start-${source}`}
					description={AUTO_START_HINTS[source]}
				>
					<Switch
						id={`auto-start-${source}`}
						checked={on.has(source)}
						disabled={sources === undefined || setSources.isPending}
						onCheckedChange={(next) => toggle(source, next)}
					/>
				</SettingRow>
			))}
		</SettingsSection>
	);
}
