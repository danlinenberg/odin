import { describe, expect, it } from "bun:test";
import { bindingToDispatchChord } from "../utils/binding";
import {
	getEffectiveLayoutMap,
	useKeyboardLayoutStore,
} from "./keyboardLayoutStore";

const SEARCH = { version: 2, mode: "logical", chord: "slash" } as const;
const layout = (entries: Record<string, string>) =>
	useKeyboardLayoutStore.setState({ map: new Map(Object.entries(entries)) });

describe("getEffectiveLayoutMap", () => {
	it("keeps shortcuts on their US keys under a non-Latin layout", () => {
		// macOS Hebrew: "/" lives on KeyQ, the Slash key prints ".".
		layout({ KeyA: "ש", KeyQ: "/", Slash: "." });
		expect(bindingToDispatchChord(SEARCH, getEffectiveLayoutMap())).toBe(
			"slash",
		);
	});

	it("still follows a Latin layout's labels", () => {
		// AZERTY: KeyA prints "q", and "/" is not on the Slash key.
		layout({ KeyA: "q", Period: "/", Slash: "!" });
		expect(bindingToDispatchChord(SEARCH, getEffectiveLayoutMap())).toBe(
			"period",
		);
	});
});
