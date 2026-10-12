import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awsProfile } from "./aws-sso";

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
