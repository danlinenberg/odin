import { useEffect } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * This computer or the remote hosts, for one session: "Remote" starts it on
 * the cluster host with the most free memory (remoteHost.hostFor). What it shows is what
 * the launch gets: untouched, it reports the host switch as the pick, so the
 * session runs where the menu said, not where the repo or connector rules
 * would send it. Nothing shows while no remote host is set up. `className` restyles the
 * menu to match the row it sits in; the default is the New Session dialog's.
 */
export function WherePicker({
	value,
	onChange,
	className = "h-7 shrink-0 rounded-[6px] bg-secondary px-2 text-[11.5px] font-semibold text-foreground outline-none [color-scheme:inherit]",
}: {
	value: boolean | undefined;
	onChange: (onHost: boolean) => void;
	className?: string;
}) {
	const { data } = electronTrpc.remoteHost.get.useQuery();
	const host = data?.host;
	const shown = (value ?? host?.on) === true;
	useEffect(() => {
		if (host && value === undefined) onChange(shown);
	}, [host, value, shown, onChange]);
	if (!host) return null;
	return (
		<select
			aria-label="Where the session runs"
			title={`Where the session runs - this computer, or the remote host with the most free memory (${[host, ...(data?.cluster ?? [])].map((each) => each.name || each.instanceId).join(", ")})`}
			value={shown ? "host" : "local"}
			onChange={(event) => onChange(event.target.value === "host")}
			className={className}
		>
			<option value="local">This computer</option>
			<option value="host">Remote</option>
		</select>
	);
}
