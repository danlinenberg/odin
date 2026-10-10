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
import { useState } from "react";
import { useNextInLinePrompt } from "renderer/stores/next-in-line-prompt";

/**
 * The first time the Night Agent is turned on or given a pick, say what it
 * does to the computer before it does it. `gate(action)` runs the action
 * right away once the notice was seen; render `dialog` beside the trigger.
 */
export function useNightAgentIntro() {
	const [pending, setPending] = useState<(() => void) | null>(null);
	const gate = (action: () => void) => {
		if (useNextInLinePrompt.getState().offHours.introSeen) action();
		else setPending(() => action);
	};
	const dialog = (
		<AlertDialog
			open={!!pending}
			onOpenChange={(open) => !open && setPending(null)}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						The Night Agent keeps your computer awake
					</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="space-y-2">
							<p>
								During its window, Odin stops your computer from going to sleep,
								so the sessions keep running. The screen can still turn off.
							</p>
							<p>
								It works only while the computer is plugged in. On battery it
								starts nothing and lets the computer sleep.
							</p>
							<p>Leave Odin open, and on a laptop leave the lid open.</p>
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={() => {
							useNextInLinePrompt.getState().setOffHours({ introSeen: true });
							pending?.();
							setPending(null);
						}}
					>
						Got it
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
	return { gate, dialog };
}
