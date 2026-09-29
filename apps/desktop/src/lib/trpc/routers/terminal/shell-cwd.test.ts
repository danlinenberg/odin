import { describe, expect, test } from "bun:test";
import { parseLsofCwds, shellCwds } from "./shell-cwd";

describe("shellCwds", () => {
	test("parses lsof's field output per pid", () => {
		expect(parseLsofCwds("p12\nfcwd\nn/a/b\np34\nfcwd\nn/c d\n")).toEqual({
			12: "/a/b",
			34: "/c d",
		});
	});

	test("reads this process's real cwd, and skips a dead pid", async () => {
		const cwds = await shellCwds([process.pid, 999_999]);
		expect(cwds[process.pid]).toBe(process.cwd());
		expect(cwds[999_999]).toBeUndefined();
	});
});
