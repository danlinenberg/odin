import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@odin/ui/alert-dialog";
import { MyTodos } from "../board/SessionBrief";
import { useDoneGuard, withOpenTodos } from "../hooks/done-guard";
import { usePaneMeta } from "../hooks/usePaneMeta";

/**
 * Done pressed while My notes still has unticked to-dos: the to-dos, live, so
 * you can tick them here, then Done anyway or Cancel. Mounted once in the
 * shell; guardDone opens it.
 */
export function OpenTodosDialog() {
	const pending = useDoneGuard((s) => s.pending);
	const close = useDoneGuard((s) => s.close);
	const todosByPane = usePaneMeta((s) => s.todosByPane);
	const sessions = pending?.sessions ?? [];
	const stillOpen = withOpenTodos(sessions, todosByPane);
	const count = stillOpen.reduce(
		(n, s) => n + (todosByPane[s.paneId] ?? []).filter((t) => !t.done).length,
		0,
	);
	return (
		<AlertDialog open={!!pending} onOpenChange={(open) => !open && close()}>
			<AlertDialogContent className="max-w-[520px]">
				<AlertDialogHeader>
					<AlertDialogTitle>
						{count
							? `${count} to-do${count === 1 ? "" : "s"} still open in My notes`
							: "Every to-do is ticked"}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{count
							? `Tick them off here, or finish ${pending?.what ?? "it"} anyway - unticked to-dos come back if you resume it from Done, on Tasks.`
							: `Nothing left open - Done finishes ${pending?.what ?? "it"}.`}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
					{sessions.map((session) => (
						<div key={session.paneId} className="flex flex-col gap-1">
							{sessions.length > 1 && (
								<div className="truncate text-[11px] font-medium text-muted-foreground">
									{session.title}
								</div>
							)}
							<MyTodos paneId={session.paneId} />
						</div>
					))}
				</div>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={() => {
							const proceed = pending?.proceed;
							close();
							proceed?.();
						}}
					>
						{count ? "Done anyway" : "Done"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
