import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AWS_CREDENTIAL_HELPER,
	awsConfigProfiles,
	awsHostConfigScript,
	isRoleArn,
} from "./aws-on-host";

test("reads profiles and their regions from an AWS config, skipping sso-session sections", () => {
	expect(
		awsConfigProfiles(
			[
				"[default]",
				"region = eu-west-1",
				"[sso-session imagen]",
				"region = us-west-2",
				"[profile prod]",
				"sso_session = imagen",
				"region = us-east-1",
				"[profile dev]",
				"[profile bad name]",
			].join("\n"),
		),
	).toEqual([
		{ name: "default", region: "eu-west-1" },
		{ name: "prod", region: "us-east-1" },
		{ name: "dev" },
	]);
});

test("the host role is an IAM role's ARN, nothing a shell or STS would choke on", () => {
	expect(
		isRoleArn("arn:aws:iam::585680601546:role/OdinHostSession"),
	).toBeTrue();
	expect(isRoleArn("arn:aws:iam::585680601546:role/path/To.Role")).toBeTrue();
	expect(isRoleArn("arn:aws:iam::585680601546:user/dan")).toBeFalse();
	expect(isRoleArn("arn:aws:iam::5856:role/x")).toBeFalse();
	expect(isRoleArn("arn:aws:iam::585680601546:role/x; rm -rf /")).toBeFalse();
});

const runIn = (home: string, script: string) =>
	execFileSync("sh", ["-c", `HOME=${home}\n${script}`]);

test("the host's ~/.aws/config gets Odin's block, rewritten in place, and keeps the user's own profiles", () => {
	const home = mkdtempSync(join(tmpdir(), "odin-aws-"));
	mkdirSync(join(home, ".aws"));
	const config = join(home, ".aws", "config");
	writeFileSync(config, "[profile mine]\nregion = eu-west-1\n");
	runIn(
		home,
		awsHostConfigScript([
			{ name: "prod", region: "us-east-1" },
			{ name: "mine" },
			{ name: "x'; touch pwned; '" },
		]),
	);
	const first = readFileSync(config, "utf8");
	expect(first).toContain("[profile mine]\nregion = eu-west-1\n");
	// The user's own credentials through the helper, at its path in their home.
	expect(first).toContain(
		`[profile prod]\ncredential_process = ${home}/.odin/bin/aws-credential-odin prod\nregion = us-east-1\n# <<< odin`,
	);
	const helper = join(home, ".odin", "bin", "aws-credential-odin");
	expect(readFileSync(helper, "utf8")).toBe(AWS_CREDENTIAL_HELPER);
	expect(statSync(helper).mode & 0o111).toBeTruthy();
	// A profile the user wrote stays theirs; a name a shell would read never lands.
	expect(first.match(/\[profile mine\]/g)).toHaveLength(1);
	expect(first).not.toContain("pwned");
	// A second sync replaces the block rather than adding another.
	runIn(home, awsHostConfigScript([{ name: "dev" }]));
	const second = readFileSync(config, "utf8");
	expect(second).toContain("[profile dev]");
	expect(second).not.toContain("[profile prod]");
	expect(second.match(/# >>> odin/g)).toHaveLength(1);
	// None picked: the block goes, the user's profile stays.
	runIn(home, awsHostConfigScript([]));
	expect(readFileSync(config, "utf8")).toBe(
		"[profile mine]\nregion = eu-west-1\n",
	);
});
