import { describe, expect, it } from "bun:test";
import { getCurrentBranch } from "./git";

describe("getCurrentBranch", () => {
	it("is null for a folder this machine doesn't have (a remote server's)", async () => {
		expect(await getCurrentBranch("/data/no/such/server/folder")).toBeNull();
	});
});
