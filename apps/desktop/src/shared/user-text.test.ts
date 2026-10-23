import { expect, test } from "bun:test";
import {
	DISMISSED_HEAD,
	isInterruptMarker,
	withoutWrapping,
} from "./user-text";

test("a pasted message shows as you wrote it, without Odin's dismissal note", () => {
	const logged =
		'\n\n<pasted_content id="a9e6">\ndsa\n\n(I dismissed these action items - do not list them again:\n- Restart Odin on your Mac on the latest main (you only).\n- Fix the keychain prompt, then run the install block once (you only).)\n</pasted_content id="a9e6">\n';
	expect(withoutWrapping(logged)).toBe("dsa");
});

test("the note Odin writes is the note it strips", () => {
	expect(withoutWrapping(`Ship it\n\n${DISMISSED_HEAD}\n- Merge #12)`)).toBe(
		"Ship it",
	);
});

test("a message with parentheses of its own keeps them", () => {
	expect(withoutWrapping("Fix (the) bug")).toBe("Fix (the) bug");
	expect(withoutWrapping("Line one\n\nLine two (see above)")).toBe(
		"Line one\n\nLine two (see above)",
	);
});

test("Claude Code's interrupt marker is an event, not a message", () => {
	expect(isInterruptMarker("[Request interrupted by user]")).toBe(true);
	expect(isInterruptMarker("[Request interrupted by user for tool use]")).toBe(
		true,
	);
	expect(isInterruptMarker("Why was the [Request interrupted by user]?")).toBe(
		false,
	);
});
