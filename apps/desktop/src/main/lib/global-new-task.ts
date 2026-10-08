import { app, BrowserWindow, globalShortcut } from "electron";
import { focusMainWindow } from "main/index";
import { chordToAccelerator } from "shared/chord-accelerator";
import { menuEmitter } from "./menu-events";

let registered: string | null = null;

/**
 * Makes the New Task chord work from any app: raises Odin and opens the
 * quick-add box. The renderer owns the binding (rebindable in Settings), so
 * it pushes the current chord here; null turns it off.
 */
export function setGlobalNewTaskChord(chord: string | null): void {
	const accelerator = chord ? chordToAccelerator(chord) : null;
	if (accelerator === registered) return;
	if (registered) globalShortcut.unregister(registered);
	registered = null;
	if (!accelerator) return;
	const ok = globalShortcut.register(accelerator, () => {
		// Pressed from another app: hide again once the task is saved, so
		// focus goes back to where you were.
		const fromElsewhere = !BrowserWindow.getFocusedWindow();
		if (process.platform === "darwin") app.focus({ steal: true });
		focusMainWindow();
		menuEmitter.emit("new-task", fromElsewhere);
	});
	if (ok) registered = accelerator;
	else console.warn(`[global-new-task] ${accelerator} is taken by another app`);
}

app.on("will-quit", () => globalShortcut.unregisterAll());
