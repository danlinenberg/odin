import { expect, test } from "bun:test";
import { isDismissed, withDismissalNote } from "./dismissed-match";
import { withoutWrapping } from "./user-text";

test("a dismissed item stays hidden when Claude rewords it a little", () => {
	const dismissed = ["Restart Odin on your Mac after #1450 merges (you only)."];
	expect(
		isDismissed(dismissed, "Restart Odin on your Mac after #1450 merges."),
	).toBe(true);
	expect(
		isDismissed(dismissed, "Tell me whether to build the next batch."),
	).toBe(false);
});

test("the note a phone reply carries is the one the chat strips again", () => {
	const sent = withDismissalNote("yes", ["Merge #12"]);
	expect(sent).toContain("Merge #12");
	expect(withoutWrapping(sent)).toBe("yes");
	expect(withDismissalNote("yes", [])).toBe("yes");
});
