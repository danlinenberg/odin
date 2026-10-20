import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalLink, awsProfile } from "./aws-sso";

test("awsProfile prefers Claude's settings env, then the shell's", () => {
	const home = mkdtempSync(join(tmpdir(), "odin-aws-"));
	expect(awsProfile(home, undefined)).toBeUndefined();
	expect(awsProfile(home, "shell")).toBe("shell");
	mkdirSync(join(home, ".claude"));
	writeFileSync(
		join(home, ".claude", "settings.json"),
		JSON.stringify({ env: { AWS_PROFILE: "bedrock" } }),
	);
	expect(awsProfile(home, "shell")).toBe("bedrock");
});

test("approvalLink takes the code-filled URL the device flow prints last", () => {
	const output =
		"Browser will not be automatically opened.\nPlease visit the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n\nThen enter the code:\n\nABCD-EFGH\n\nAlternatively, you may visit the following URL which will autofill the code upon loading:\nhttps://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH\n";
	expect(approvalLink(output)).toBe(
		"https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH",
	);
	expect(approvalLink("nothing yet")).toBeNull();
});
