import { expect, test } from "bun:test";
import {
	isDismissed,
	useDismissedActions,
	withDismissals,
} from "./dismissed-actions";

test("a dismissed item stays hidden when Claude rewords its choices or links", () => {
	const dismissed = [
		"Add the package-index token to /prod/services/feature-builder (you only).",
		"Choose the Odin Run button: [keep #988 only | merge both | replace #988] (you only).",
	];
	expect(
		isDismissed(
			dismissed,
			"Add the package-index token to /prod/services/feature-builder.",
		),
	).toBe(true);
	expect(
		isDismissed(
			dismissed,
			"Choose the Odin Run button: [keep [#988](https://x/988) | merge both]",
		),
	).toBe(true);
	expect(
		isDismissed(
			dismissed,
			"Add CODEOWNERS human review for ladis/* branches (you only).",
		),
	).toBe(false);
	expect(isDismissed([], "anything")).toBe(false);
});

test("the next message tells Claude once", () => {
	useDismissedActions.getState().dismiss("p1", "Merge PR #1");
	expect(withDismissals("p1", "hi")).toBe(
		"hi\n\n(I dismissed these action items - do not list them again:\n- Merge PR #1)",
	);
	expect(withDismissals("p1", "again")).toBe("again");
	expect(
		useDismissedActions.getState().panes.find((p) => p.paneId === "p1")?.items,
	).toEqual(["Merge PR #1"]);
});
