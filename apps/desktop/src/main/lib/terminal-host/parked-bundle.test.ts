import { describe, expect, it } from "bun:test";
import { parkedBundleIn } from "./parked-bundle";

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
