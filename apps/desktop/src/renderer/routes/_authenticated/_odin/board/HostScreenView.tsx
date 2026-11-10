import RFB from "@novnc/novnc";
import { useEffect, useRef, useState } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import type { HostScreen } from "renderer/stores/host-view";
import { useTabsStore } from "renderer/stores/tabs/store";

/**
 * The drawer's View tab: the app a remote session runs on its host (a
 * `!view` block's VNC server), drawn here by noVNC through an ssh tunnel
 * main opens over the host's bridge. noVNC asks for tight encoding with JPEG,
 * far less over the link than Screen Sharing's lossless zlib.
 */
export function HostScreenView({
	paneId,
	screen,
}: {
	paneId: string;
	screen: HostScreen;
}) {
	const target = useRef<HTMLDivElement>(null);
	const [status, setStatus] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [attempt, setAttempt] = useState(0);
	const lost = status !== null && status !== "Connecting to the host…";

	useEffect(() => {
		// Re-runs on Reconnect (attempt) as well as for a new screen.
		void attempt;
		let rfb: RFB | null = null;
		let gone = false;
		setStatus("Connecting to the host…");
		electronTrpcClient.remoteHost.viewOnMac
			.mutate({
				host: useTabsStore.getState().panes[paneId]?.odinRemote,
				port: screen.port,
			})
			.then(({ port }) => {
				if (gone || !target.current) return;
				rfb = new RFB(target.current, `ws://127.0.0.1:${port}/`, {
					credentials: { password: screen.password },
				});
				rfb.scaleViewport = true;
				rfb.addEventListener("connect", () => setStatus(null));
				rfb.addEventListener("desktopname", (event) =>
					setName(event.detail.name),
				);
				rfb.addEventListener("disconnect", (event) => {
					if (gone) return;
					setStatus(
						event.detail.clean
							? "The app's screen closed."
							: "Lost the connection to the app on the host.",
					);
				});
			})
			.catch((error: Error) => {
				if (!gone) setStatus(error.message);
			});
		return () => {
			gone = true;
			rfb?.disconnect();
		};
	}, [paneId, screen.port, screen.password, attempt]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-4 text-[11px] text-muted-foreground">
				{name || "The app running on the host"} - ▣ View again goes back to the
				session
			</div>
			<div className="relative min-h-0 flex-1 bg-[#111]">
				<div ref={target} className="absolute inset-0" />
				{status && (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[13px] text-muted-foreground">
						<span className="select-text cursor-text">{status}</span>
						{lost && (
							<button
								type="button"
								onClick={() => setAttempt((n) => n + 1)}
								className="rounded-md bg-secondary px-3 py-1 text-xs font-semibold text-foreground hover:bg-secondary/80"
							>
								Reconnect
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
