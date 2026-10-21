import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * This computer or the remote host, for one session. `value` stays undefined
 * until you pick, so the launch keeps Settings' rule (host switch, connectors).
 * Nothing shows while no remote host is set up. `className` restyles the
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
	if (!host) return null;
	return (
		<select
			aria-label="Where the session runs"
			title="Where the session runs - this computer or the remote host"
			value={(value ?? host.on) ? "host" : "local"}
			onChange={(event) => onChange(event.target.value === "host")}
			className={className}
		>
			<option value="local">This computer</option>
			<option value="host">Remote: {host.name || host.instanceId}</option>
		</select>
	);
}
