import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cameFromPhone } from "shared/from-phone";
import { phoneSentFile, rememberFromPhone, sentFromPhone } from "./sent";

phoneSentFile.path = join(
	mkdtempSync(join(tmpdir(), "odin-sent-")),
	"sent.json",
);

test("a session remembers what the phone sent it, and the chat can find it", () => {
	rememberFromPhone("pane-1", "  Approve the migration ");
	rememberFromPhone("pane-2", "something else");
	expect(sentFromPhone("pane-1")).toEqual(["Approve the migration"]);
	const sent = sentFromPhone("pane-1");
	expect(cameFromPhone("[Image #1] Approve the migration", sent)).toBe(true);
	expect(cameFromPhone("Typed at the desk", sent)).toBe(false);
});
