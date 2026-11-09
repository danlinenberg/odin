import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parkedBundleIn, signedUnlike } from "./parked-bundle";

describe.if(process.platform === "darwin")("signedUnlike", () => {
	const dir = mkdtempSync(join(tmpdir(), "odin-sign-"));
	const signed = (name: string) => {
		const path = join(dir, name);
		writeFileSync(path, `#!/bin/sh\necho ${name}\n`, { mode: 0o755 });
		execFileSync("codesign", ["-s", "-", path]);
		return path;
	};
	const a = signed("a");
	const b = signed("b");

	it("is true for two different signatures", async () => {
		expect(await signedUnlike(a, b)).toBe(true);
	});

	it("is false for the same signature", async () => {
		expect(await signedUnlike(a, a)).toBe(false);
	});

	it("is false when a signature can't be read", async () => {
		expect(await signedUnlike(join(dir, "missing"), a)).toBe(false);
	});
});

describe("parkedBundleIn", () => {
	it("finds the parked bundle the daemon runs from", () => {
		const lsof = [
			"p4242",
			"fcwd",
			"n/",
			"ftxt",
			"n/Users/tal/.odin/stale/Odin-1791635534.app/Contents/Frameworks/Odin Helper.app/Contents/MacOS/Odin Helper",
			"n/Users/tal/.odin/stale/Odin-1791635534.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
		].join("\n");
		expect(parkedBundleIn(lsof)).toBe(
			"/Users/tal/.odin/stale/Odin-1791635534.app",
		);
	});

	it("is null for a daemon on the installed Odin", () => {
		const lsof = [
			"p4242",
			"ftxt",
			"n/Applications/Odin.app/Contents/MacOS/Odin",
			"n/Users/tal/.odin/terminal-host.sock",
		].join("\n");
		expect(parkedBundleIn(lsof)).toBeNull();
	});
});
