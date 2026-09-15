import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@odin/ui/alert-dialog";
import { Button } from "@odin/ui/button";
import { Kbd, KbdGroup } from "@odin/ui/kbd";
import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
	HOTKEYS,
	type HotkeyId,
	type ShortcutBinding,
	useFormatBinding,
	useHotkeyDisplay,
	useHotkeyOverridesStore,
	useRecordHotkeys,
} from "renderer/hotkeys";

/**
 * Odin lists one shortcut per tab in its rail and nothing else — the upstream
 * workspace/terminal/layout hotkeys stay registered (other code binds them) but
 * this shell has no UI for them, so showing them here was noise.
 */
const LISTED_HOTKEYS: HotkeyId[] = [
	"ODIN_BOARD",
	"ODIN_TASKS",
	"ODIN_SLACK",
	"ODIN_SESSIONS",
	"ODIN_JIRA",
	"ODIN_PRS",
	"ODIN_NOTION",
	"ODIN_NEW_TASK",
];

function HotkeyRow({
	id,
	label,
	description,
	isRecording,
	onStartRecording,
	onReset,
}: {
	id: HotkeyId;
	label: string;
	description?: string;
	isRecording: boolean;
	onStartRecording: () => void;
	onReset: () => void;
}) {
	const { keys } = useHotkeyDisplay(id);

	return (
		<div
			className={cn(
				"flex items-center justify-between gap-4 py-3 px-4 transition-colors",
				isRecording && "bg-destructive/5",
			)}
		>
			<div className="flex flex-col">
				<span className="text-sm text-foreground">{label}</span>
				{description && (
					<span className="text-xs text-muted-foreground">{description}</span>
				)}
			</div>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={onStartRecording}
					className={cn(
						"h-7 px-3 rounded-md border text-xs transition-colors",
						isRecording
							? "border-destructive/50 bg-destructive/10 text-destructive ring-2 ring-destructive/20"
							: "border-border bg-accent/20 text-foreground hover:bg-accent/40",
					)}
				>
					{isRecording ? (
						<span>Press a key…</span>
					) : (
						<KbdGroup>
							{keys.map((key) => (
								<Kbd key={key}>{key}</Kbd>
							))}
						</KbdGroup>
					)}
				</button>
				<Button variant="ghost" size="sm" onClick={onReset}>
					Reset
				</Button>
			</div>
		</div>
	);
}

export const Route = createFileRoute("/_authenticated/settings/keyboard/")({
	component: KeyboardShortcutsPage,
});

function KeyboardShortcutsPage() {
	const [recordingId, setRecordingId] = useState<HotkeyId | null>(null);
	const [pendingConflict, setPendingConflict] = useState<{
		targetId: HotkeyId;
		binding: ShortcutBinding;
		conflictId: HotkeyId;
	} | null>(null);

	const resetOverride = useHotkeyOverridesStore((s) => s.resetOverride);
	const resetAll = useHotkeyOverridesStore((s) => s.resetAll);
	const setOverride = useHotkeyOverridesStore((s) => s.setOverride);

	useRecordHotkeys(recordingId, {
		// New printable bindings follow the printed character (matches what the
		// user sees on their keyboard). F-keys / named keys are forced to
		// "named" by the recorder regardless of this preference.
		preferredMode: "logical",
		onSave: () => setRecordingId(null),
		onCancel: () => setRecordingId(null),
		onUnassign: () => setRecordingId(null),
		onConflict: (targetId, binding, conflictId) => {
			setPendingConflict({ targetId, binding, conflictId });
			setRecordingId(null);
		},
		onReserved: (_binding, info) => {
			if (info.severity === "error") {
				toast.error(info.reason);
				setRecordingId(null);
			} else {
				toast.warning(info.reason);
			}
		},
	});

	const { keys: showHotkeysKeys } = useHotkeyDisplay("SHOW_HOTKEYS");

	const handleStartRecording = (id: HotkeyId) => {
		setRecordingId((current) => (current === id ? null : id));
	};

	const handleConflictReassign = () => {
		if (!pendingConflict) return;
		setOverride(pendingConflict.conflictId, null);
		setOverride(pendingConflict.targetId, pendingConflict.binding);
		setPendingConflict(null);
	};

	const conflictDisplay = useFormatBinding(pendingConflict?.binding ?? null);

	return (
		<div className="p-6 max-w-4xl w-full">
			{/* Header */}
			<div className="mb-6 flex items-start justify-between gap-4">
				<div>
					<h2 className="text-xl font-semibold">Keyboard shortcuts</h2>
					<p className="text-sm text-muted-foreground mt-1">
						Customize keyboard shortcuts for your workflow. Press{" "}
						<KbdGroup>
							{showHotkeysKeys.map((key) => (
								<Kbd key={key}>{key}</Kbd>
							))}
						</KbdGroup>{" "}
						to open this page anytime.
					</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						setRecordingId(null);
						resetAll();
					}}
				>
					Reset all
				</Button>
			</div>

			{/* One row per tab in the rail */}
			<div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
				{LISTED_HOTKEYS.map((id) => (
					<HotkeyRow
						key={id}
						id={id}
						label={HOTKEYS[id].label}
						description={HOTKEYS[id].description}
						isRecording={recordingId === id}
						onStartRecording={() => handleStartRecording(id)}
						onReset={() => {
							setRecordingId((current) => (current === id ? null : current));
							resetOverride(id);
						}}
					/>
				))}
			</div>

			{/* Conflict dialog */}
			<AlertDialog
				open={!!pendingConflict}
				onOpenChange={() => setPendingConflict(null)}
			>
				<AlertDialogContent className="max-w-[380px] gap-0 p-0">
					<AlertDialogHeader className="px-4 pt-4 pb-2">
						<AlertDialogTitle className="font-medium">
							Shortcut already in use
						</AlertDialogTitle>
						<AlertDialogDescription asChild>
							<div className="text-muted-foreground space-y-1.5">
								<span className="block">
									{pendingConflict
										? `${conflictDisplay.text} is already assigned to "${
												HOTKEYS[pendingConflict.conflictId].label
											}".`
										: ""}
								</span>
								<span className="block">Would you like to reassign it?</span>
							</div>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter className="px-4 pb-4 pt-2 flex-row justify-end gap-2">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setPendingConflict(null)}
						>
							Cancel
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={handleConflictReassign}
						>
							Reassign
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
