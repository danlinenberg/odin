import { expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readScreens } from "./screens";

test("the phone's screens: both files, and a version that follows their text", async () => {
	const dir = mkdtempSync(join(tmpdir(), "odin-screens-"));
	expect(await readScreens(dir)).toBeNull();
	writeFileSync(join(dir, "app.js"), "console.log(1)");
	expect(await readScreens(dir)).toBeNull();
	writeFileSync(join(dir, "app.css"), "body{}");
	const first = await readScreens(dir);
	expect(first).toMatchObject({ js: "console.log(1)", css: "body{}" });
	expect(first?.version).toMatch(/^[0-9a-f]{16}$/);
	writeFileSync(join(dir, "app.js"), "console.log(2)");
	// A rebuild in the same second still reads as new: size or time moves.
	utimesSync(join(dir, "app.js"), new Date(), new Date(Date.now() + 5000));
	const second = await readScreens(dir);
	expect(second?.js).toBe("console.log(2)");
	expect(second?.version).not.toBe(first?.version);
});
