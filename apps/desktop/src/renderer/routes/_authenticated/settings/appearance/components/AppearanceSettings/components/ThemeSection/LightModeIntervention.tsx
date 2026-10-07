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
import stopItGetSomeHelp from "renderer/assets/memes/stop-it-get-some-help.mp4";

interface LightModeInterventionProps {
	open: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function LightModeIntervention({
	open,
	onConfirm,
	onCancel,
}: LightModeInterventionProps) {
	return (
		<AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Stop it. Get some help.</AlertDialogTitle>
					<AlertDialogDescription>
						You are about to turn on light mode. Are you sure?
					</AlertDialogDescription>
				</AlertDialogHeader>
				<video
					src={stopItGetSomeHelp}
					aria-label="Michael Jordan saying: Stop it. Get some help."
					className="w-full rounded-md"
					autoPlay
					loop
					muted
					playsInline
				/>
				<AlertDialogFooter>
					<AlertDialogCancel autoFocus>Keep dark mode</AlertDialogCancel>
					<AlertDialogAction variant="ghost" onClick={onConfirm}>
						Yes, light mode
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
