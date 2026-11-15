import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostLinkFile, hostLinkFor, saveHostLink } from "./host-link";

hostLinkFile.path = join(
	mkdtempSync(join(tmpdir(), "odin-host-link-")),
	"link.json",
);

test("each profile keeps its own link on a shared host", () => {
	saveHostLink("i-1", "odin://pair?k=work", "work");
	saveHostLink("i-1", "odin://pair?k=personal", "personal");
	expect(hostLinkFor("i-1", "work")).toBe("odin://pair?k=work");
	expect(hostLinkFor("i-1", "personal")).toBe("odin://pair?k=personal");
	// A profile never synced, another host, no host: none.
	expect(hostLinkFor("i-1", "side")).toBeNull();
	expect(hostLinkFor("i-2", "work")).toBeNull();
	expect(hostLinkFor(undefined, "work")).toBeNull();
});

test("a file from before links were kept per profile stands for its host", () => {
	writeFileSync(
		hostLinkFile.path,
		JSON.stringify({ instanceId: "i-1", link: "odin://pair?k=old" }),
	);
	expect(hostLinkFor("i-1", "work")).toBe("odin://pair?k=old");
	expect(hostLinkFor("i-2", "work")).toBeNull();
});
