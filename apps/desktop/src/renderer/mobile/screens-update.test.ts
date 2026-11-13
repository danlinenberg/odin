import { expect, test } from "bun:test";
import { shouldReload } from "./screens-update";

test("reloads into new screens only when nothing is lost and it can't loop", () => {
	expect(shouldReload("v2", { unsaved: false })).toBe(true);
	expect(shouldReload("v2", { unsaved: true })).toBe(false);
	// boot.ts set v2 aside: a reload would run the built-in screens again.
	expect(shouldReload("v2", { unsaved: false, bad: "v2" })).toBe(false);
	// Already reloaded for v2 in this launch and still not running it.
	expect(shouldReload("v2", { unsaved: false, reloaded: "v2" })).toBe(false);
	expect(shouldReload("v3", { unsaved: false, reloaded: "v2" })).toBe(true);
});
