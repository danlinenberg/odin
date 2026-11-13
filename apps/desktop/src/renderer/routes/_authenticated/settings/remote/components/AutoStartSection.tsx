import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@odin/ui/collapsible";
import { toast } from "@odin/ui/sonner";
import { Switch } from "@odin/ui/switch";
import { useState } from "react";
import { HiChevronDown } from "react-icons/hi2";
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
 * when a switch goes on are left alone. The switches start collapsed.
 */
export function AutoStartSection() {
	const utils = electronTrpc.useUtils();
	const { data: remote } = electronTrpc.remoteHost.get.useQuery();
	const { data: sources } = electronTrpc.remoteHost.autoStart.useQuery();
	const setSources = electronTrpc.remoteHost.setAutoStart.useMutation({
		onSuccess: () => void utils.remoteHost.autoStart.invalidate(),
		onError: (error) => toast.error(error.message),
	});
	const [open, setOpen] = useState(false);
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
			<Collapsible open={open} onOpenChange={setOpen}>
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className="flex w-full items-center gap-1.5 px-4 py-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
					>
						<HiChevronDown
							className={`size-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
						/>
						Sources ({on.size} on)
					</button>
				</CollapsibleTrigger>
				<CollapsibleContent className="divide-y divide-border border-t border-border">
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
				</CollapsibleContent>
			</Collapsible>
		</SettingsSection>
	);
}
