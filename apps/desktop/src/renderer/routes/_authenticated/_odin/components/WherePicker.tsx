import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * This computer or the remote host, for one session. `value` stays undefined
 * until you pick, so the launch keeps Settings' rule (host switch, connectors).
 * Nothing shows while no remote host is set up.
 */
export function WherePicker({
	value,
	onChange,
}: {
	value: boolean | undefined;
	onChange: (onHost: boolean) => void;
}) {
	const { data } = electronTrpc.remoteHost.get.useQuery();
	const host = data?.host;
	if (!host) return null;
	return (
		<select
			aria-label="Where the session runs"
			value={(value ?? host.on) ? "host" : "local"}
			onChange={(event) => onChange(event.target.value === "host")}
			className="h-7 shrink-0 rounded-[6px] bg-secondary px-2 text-[11.5px] font-semibold text-foreground outline-none [color-scheme:inherit]"
		>
			<option value="local">This computer</option>
			<option value="host">Remote: {host.name || host.instanceId}</option>
		</select>
	);
}
