import { ODIN_AUTO_RENAME_SESSIONS_DEFAULT } from "@odin/shared/constants";
import { Label } from "@odin/ui/label";
import { Switch } from "@odin/ui/switch";
import { createFileRoute } from "@tanstack/react-router";
import { electronTrpc } from "renderer/lib/electron-trpc";

export const Route = createFileRoute("/_authenticated/settings/board/")({
	component: BoardSettingsPage,
});

/**
 * The board's own settings. One toggle so far — no item-visibility plumbing,
 * because every setting on this page is Odin's own and shows in every variant.
 */
function BoardSettingsPage() {
	const utils = electronTrpc.useUtils();
	const { data: autoRename, isLoading } =
		electronTrpc.settings.getOdinAutoRenameSessions.useQuery();
	const setAutoRename =
		electronTrpc.settings.setOdinAutoRenameSessions.useMutation({
			onMutate: async ({ enabled }) => {
				await utils.settings.getOdinAutoRenameSessions.cancel();
				const previous = utils.settings.getOdinAutoRenameSessions.getData();
				utils.settings.getOdinAutoRenameSessions.setData(undefined, enabled);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getOdinAutoRenameSessions.setData(
						undefined,
						context.previous,
					);
				}
			},
			onSettled: () => utils.settings.getOdinAutoRenameSessions.invalidate(),
		});

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Board</h2>
				<p className="text-sm text-muted-foreground mt-1">
					How the board names and shows your sessions
				</p>
			</div>

			<div className="space-y-6">
				<div className="flex items-center justify-between">
					<div className="space-y-0.5">
						<Label
							htmlFor="auto-rename-sessions"
							className="text-sm font-medium"
						>
							Rename sessions automatically
						</Label>
						<p className="text-xs text-muted-foreground">
							Name each card after what its session turned out to be about,
							instead of the first line you typed. Renamed once, from the brief
							already written for the card; a name you set yourself is left
							alone.
						</p>
					</div>
					<Switch
						id="auto-rename-sessions"
						checked={autoRename ?? ODIN_AUTO_RENAME_SESSIONS_DEFAULT}
						onCheckedChange={(enabled) => setAutoRename.mutate({ enabled })}
						disabled={isLoading || setAutoRename.isPending}
					/>
				</div>
			</div>
		</div>
	);
}
