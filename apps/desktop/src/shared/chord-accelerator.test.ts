import { expect, it } from "bun:test";
import { chordToAccelerator } from "./chord-accelerator";

it("maps hotkey chords to Electron accelerators", () => {
	expect(chordToAccelerator("meta+shift+a")).toBe("Super+Shift+A");
	expect(chordToAccelerator("ctrl+shift+alt+a")).toBe("Control+Shift+Alt+A");
	expect(chordToAccelerator("ctrl+slash")).toBe("Control+/");
	expect(chordToAccelerator("meta+alt+up")).toBe("Super+Alt+Up");
	expect(chordToAccelerator("ctrl+f12")).toBe("Control+F12");
});

it("refuses chords that would swallow typing in other apps", () => {
	expect(chordToAccelerator("a")).toBeNull();
	expect(chordToAccelerator("shift+a")).toBeNull();
	expect(chordToAccelerator("hyper+a")).toBeNull();
	expect(chordToAccelerator("meta+nosuchkey")).toBeNull();
});
