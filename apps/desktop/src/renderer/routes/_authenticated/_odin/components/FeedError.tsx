import { cn } from "@odin/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { FEED_NOTICE_BOX } from "./FeedChrome";

/**
 * A feed that failed to load. UNAUTHORIZED means the stored token is dead
 * (revoked, expired), which is fixable in one place — so the box carries the
 * way there instead of leaving a raw API error in a dead end.
 */
export function FeedError({
	error,
}: {
	error: { message: string; data?: { code?: string } | null } | null;
}) {
	const navigate = useNavigate();
	if (!error) return null;
	return (
		<div
			className={cn(
				FEED_NOTICE_BOX,
				"flex cursor-text select-text items-center gap-3 border border-[#5a2733] bg-[#f0647a]/10",
			)}
		>
			<span className="min-w-0 flex-1">{error.message}</span>
			{error.data?.code === "UNAUTHORIZED" && (
				<button
					type="button"
					onClick={() => navigate({ to: "/settings/connections" })}
					className="shrink-0 rounded-[7px] bg-[#211d3a] px-2.5 py-1 font-semibold text-[#a394ff] hover:bg-[#28224a]"
				>
					Reconnect →
				</button>
			)}
		</div>
	);
}
