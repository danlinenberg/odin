import { useEffect, useId } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * This computer or the remote hosts, for one session: "Remote" starts it on
 * the cluster host with the most free memory (remoteHost.hostFor). What it shows is what
 * the launch gets: untouched, it reports the host switch as the pick, so the
 * session runs where the menu said, not where the repo or connector rules
 * would send it. Nothing shows while no remote host is set up. Two radio
 * buttons, Local and Remote, so both choices show at a glance.
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
	const shown = (value ?? host?.on) === true;
	const name = useId();
	useEffect(() => {
		if (host && value === undefined) onChange(shown);
	}, [host, value, shown, onChange]);
	if (!host) return null;
	return (
		<div
			role="radiogroup"
			aria-label="Where the session runs"
			title={`Where the session runs - this computer, or the remote host with the most free memory (${[host, ...(data?.cluster ?? [])].map((each) => each.name || each.instanceId).join(", ")})`}
			className="flex h-7 shrink-0 rounded-[7px] bg-secondary p-0.5 ring-1 ring-inset ring-border"
		>
			{(
				[
					[false, "Local"],
					[true, "Remote"],
				] as const
			).map(([onHost, label]) => (
				<label
					key={label}
					className="flex cursor-pointer items-center rounded-[5px] px-2.5 text-[11.5px] font-semibold text-muted-foreground has-checked:bg-background has-checked:text-foreground has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-primary"
				>
					<input
						type="radio"
						name={name}
						checked={shown === onHost}
						onChange={() => onChange(onHost)}
						className="sr-only"
					/>
					{label}
				</label>
			))}
		</div>
	);
}
