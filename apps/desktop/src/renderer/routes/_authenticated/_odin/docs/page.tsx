import { toast } from "@odin/ui/sonner";
import { createFileRoute } from "@tanstack/react-router";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { FeedDivider, FeedHeader } from "../components/FeedChrome";

export const Route = createFileRoute("/_authenticated/_odin/docs/")({
	component: DocsPage,
});

/**
 * Docs - what you worked out in a session, kept to read later or hand to a
 * new task (the task box's Doc picker). Not a task: no status, no due date.
 * The files in ~/.odin/docs are the store; a title opens one in your editor.
 */
function DocsPage() {
	const { data: docs = [] } = electronTrpc.system.listDocs.useQuery();
	const open = electronTrpc.external.openFileInEditor.useMutation({
		onError: (error) => toast.error(`Couldn't open the doc: ${error.message}`),
	});
	const reveal = electronTrpc.external.openInFinder.useMutation();

	return (
		<div className="flex h-full flex-col">
			<FeedHeader>
				<FeedDivider />
				<span className="shrink-0 text-[12px] text-muted-foreground">
					saved from sessions · right-click a session → Save as doc
				</span>
			</FeedHeader>
			{docs.length === 0 ? (
				<div className="px-[18px] py-10 text-center text-[13px] text-muted-foreground">
					No docs yet. Brainstorm in a session, then right-click its card → Save
					as doc.
				</div>
			) : (
				<ul className="min-h-0 flex-1 overflow-y-auto px-[18px] py-2">
					{docs.map((doc) => (
						<li
							key={doc.path}
							className="flex items-center gap-3 border-b border-border py-2"
						>
							<button
								type="button"
								title={doc.path}
								onClick={() => open.mutate({ path: doc.path })}
								className="min-w-0 truncate text-left text-[13px] font-semibold text-foreground hover:text-primary"
							>
								{doc.title}
							</button>
							<span className="min-w-0 truncate text-[12px] text-muted-foreground">
								{doc.path.split("/").pop()}
							</span>
							<button
								type="button"
								onClick={() => reveal.mutate(doc.path)}
								className="ml-auto shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
							>
								Show in Finder
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
