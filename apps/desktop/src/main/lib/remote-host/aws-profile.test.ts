import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	awsProfileFor,
	fallbackAwsProfile,
	profileRegion,
} from "./aws-profile";
import { awsClientConfig } from "./ssm";

/** An AWS config with only named profiles - no [default] - as many SSO setups have. */
const NAMED_ONLY = "[profile foo]\nregion = eu-west-1\n";

const AWS_VARS = [
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_EC2_METADATA_DISABLED",
	"AWS_PROFILE",
	"AWS_DEFAULT_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
];

describe("an AWS config without a default profile", () => {
	let dir: string;
	const before = new Map(AWS_VARS.map((key) => [key, process.env[key]]));
	beforeEach(() => {
		for (const key of AWS_VARS) delete process.env[key];
		dir = mkdtempSync(join(tmpdir(), "odin-aws-"));
		writeFileSync(join(dir, "config"), NAMED_ONLY);
		writeFileSync(
			join(dir, "credentials"),
			"[foo]\naws_access_key_id = AKIDFOO\naws_secret_access_key = secretfoo\n",
		);
		process.env.AWS_CONFIG_FILE = join(dir, "config");
		process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, "credentials");
		process.env.AWS_EC2_METADATA_DISABLED = "true";
	});
	afterEach(() => {
		for (const [key, value] of before)
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		rmSync(dir, { recursive: true, force: true });
	});

	test("no profile picked: Odin signs in with the config's profile, not a missing [default]", async () => {
		const config = awsClientConfig({});
		const credentials = await config.credentials();
		expect(credentials.accessKeyId).toBe("AKIDFOO");
		expect(config.region).toBe("eu-west-1");
	});

	test("the health check and sign-in name that profile, not default", () => {
		expect(awsProfileFor(undefined)).toBe("foo");
		expect(awsProfileFor("")).toBe("foo");
		expect(awsProfileFor("bar")).toBe("bar");
	});

	test("a region picked in Settings wins over the profile's", () => {
		expect(awsClientConfig({ region: "us-east-1" }).region).toBe("us-east-1");
	});
});

describe("fallbackAwsProfile", () => {
	test("AWS's own default when there is one", () => {
		expect(fallbackAwsProfile(["default", "foo"], {})).toBeUndefined();
		expect(fallbackAwsProfile(["foo"], { AWS_PROFILE: "foo" })).toBeUndefined();
		expect(fallbackAwsProfile([], {})).toBeUndefined();
	});

	test("keys in the environment keep working: no profile is forced over them", () => {
		expect(
			fallbackAwsProfile(["foo"], { AWS_ACCESS_KEY_ID: "AKID" }),
		).toBeUndefined();
	});

	test("the first named profile when there is no [default]", () => {
		expect(fallbackAwsProfile(["bar", "foo"], {})).toBe("bar");
	});
});

describe("profileRegion", () => {
	const config =
		"[default]\nregion = us-east-1\n[profile foo]\nsso_session = x\nregion = eu-west-1\n[sso-session x]\nsso_region = us-west-2\n";
	test("reads the region of that profile's section only", () => {
		expect(profileRegion(config, "foo")).toBe("eu-west-1");
		expect(profileRegion(config, "default")).toBe("us-east-1");
		expect(profileRegion(config, "missing")).toBeUndefined();
	});
});
