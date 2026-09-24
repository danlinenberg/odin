import { useEffect } from "react";
import { createPortal } from "react-dom";
import { LuExternalLink, LuX } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * Chrome without the Electron marker: Slack and a few others refuse "Electron"
 * user agents with an "unsupported browser" page.
 */
const USER_AGENT = navigator.userAgent
	.replace(/ Electron\/\S+/, "")
	.replace(/ [Oo]din[^ ]*\/\S+/, "");

/**
 * The task's own page — the Slack thread, the Jira ticket, the PR — in a
 * drawer over the board, so you can read it before deciding to start it.
 * A persistent partition keeps you signed in to each site across restarts.
 */
export function SourceDrawer({
	url,
	title,
	onClose,
}: {
	url: string;
	title: string;
	onClose: () => void;
}) {
	const openUrl = electronTrpc.external.openUrl.useMutation();
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return createPortal(
		<div className="fixed inset-y-0 right-0 z-50 flex w-[min(960px,75vw)] flex-col border-l border-[#25252e] bg-[#111114] shadow-2xl">
			<div className="flex items-center gap-2 border-b border-[#25252e] px-3 py-2">
				<span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#f5f5f7]">
					{title}
				</span>
				<button
					type="button"
					onClick={() => openUrl.mutate(url)}
					title="Open in your browser"
					className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-[#a5a5b3] hover:bg-[#1f1f27] hover:text-[#f5f5f7]"
				>
					<LuExternalLink className="size-3.5" aria-hidden />
					Browser
				</button>
				<button
					type="button"
					onClick={onClose}
					title="Close (Esc)"
					className="rounded-md p-1 text-[#a5a5b3] hover:bg-[#1f1f27] hover:text-[#f5f5f7]"
				>
					<LuX className="size-4" aria-hidden />
				</button>
			</div>
			<webview
				src={url}
				partition="persist:odin-sources"
				useragent={USER_AGENT}
				className="min-h-0 flex-1"
			/>
		</div>,
		document.body,
	);
}
