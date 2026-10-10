import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	AUTO_UPDATE_STATUS,
	type AutoUpdateStatusEvent,
} from "shared/auto-update";

/**
 * A full-width strip under the top bar while a newer release is out. Nothing
 * installs on its own: the button downloads, quits and swaps. "Later" hides it
 * until the next hourly check finds the release again.
 */
export function UpdateBanner() {
	const [update, setUpdate] = useState<AutoUpdateStatusEvent>();
	electronTrpc.autoUpdate.subscribe.useSubscription(undefined, {
		onData: setUpdate,
	});
	const install = electronTrpc.autoUpdate.install.useMutation();
	const dismiss = electronTrpc.autoUpdate.dismiss.useMutation();

	const status = update?.status;
	if (
		status !== AUTO_UPDATE_STATUS.AVAILABLE &&
		status !== AUTO_UPDATE_STATUS.DOWNLOADING &&
		status !== AUTO_UPDATE_STATUS.READY
	) {
		return null;
	}
	const busy = status !== AUTO_UPDATE_STATUS.AVAILABLE;
	const percent = Math.round(update?.progress?.percent ?? 0);

	return (
		// Solid violet, not a tint: it has to win against every page under it.
		<div className="flex shrink-0 items-center gap-3 bg-gradient-to-r from-primary-ink to-primary px-4 py-2 text-primary-foreground shadow-[0_2px_16px_-2px_color-mix(in_oklab,var(--primary)_70%,transparent)]">
			<span className="size-2 shrink-0 animate-pulse rounded-full bg-white" />
			<span className="text-sm font-bold">
				Odin {update?.version} is available
			</span>
			<span className="min-w-0 cursor-text select-text truncate text-xs opacity-85">
				{status === AUTO_UPDATE_STATUS.DOWNLOADING
					? `Downloading${percent ? ` ${percent}%` : ""}…`
					: status === AUTO_UPDATE_STATUS.READY
						? "Restarting into the new version…"
						: update?.error
							? `Download failed: ${update.error}`
							: "Open terminal sessions survive the restart."}
			</span>
			<div className="flex-1" />
			{!busy && (
				<button
					type="button"
					onClick={() => dismiss.mutate()}
					className="rounded-[7px] px-3 py-1 text-xs font-medium opacity-85 hover:bg-white/15 hover:opacity-100"
				>
					Later
				</button>
			)}
			<button
				type="button"
				disabled={busy}
				onClick={() => install.mutate()}
				className="rounded-[7px] bg-white px-3 py-1 text-xs font-bold text-primary shadow-sm hover:brightness-95 disabled:opacity-60"
			>
				{busy ? "Updating…" : "Update and restart"}
			</button>
		</div>
	);
}
