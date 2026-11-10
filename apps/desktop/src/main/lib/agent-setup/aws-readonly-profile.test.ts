import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureAwsReadonlyProfile,
	readonlyProfileSection,
} from "./aws-readonly-profile";

const ACCOUNT = "585680601546";
const SESSION_CONFIG = `[sso-session imagen]
sso_start_url = https://imagen.awsapps.com/start
sso_region = us-east-1

[profile prod]
sso_session = imagen
sso_account_id = ${ACCOUNT}
sso_role_name = Frontend
region = us-east-1
`;

test("a prod profile on another role gets a read-only twin on the same SSO session", () => {
	expect(
		readonlyProfileSection(SESSION_CONFIG, ACCOUNT, "ReadOnlyAccess"),
	).toBe(
		"\n# Added by Odin: read-only twin of [profile prod], for imagen-core's AWS guard\n" +
			"[profile prod-readonly]\nsso_session = imagen\nsso_account_id = 585680601546\n" +
			"sso_role_name = ReadOnlyAccess\nregion = us-east-1\n",
	);
});

test("the older layout copies the start URL and region", () => {
	const text = `[default]\nsso_start_url = https://x/start\nsso_region = eu-west-1\nsso_account_id = ${ACCOUNT}\nsso_role_name = BackendDeveloper\n`;
	expect(readonlyProfileSection(text, ACCOUNT, "ReadOnlyAccess")).toContain(
		"[profile default-readonly]\nsso_start_url = https://x/start\nsso_region = eu-west-1\n",
	);
});

test("nothing is added when a read-only profile exists, the name is taken, or no profile is in prod", () => {
	const ro = `${SESSION_CONFIG}\n[profile mine]\nsso_session = imagen\nsso_account_id = ${ACCOUNT}\nsso_role_name = ReadOnlyAccess\n`;
	expect(readonlyProfileSection(ro, ACCOUNT, "ReadOnlyAccess")).toBeNull();
	const taken = `${SESSION_CONFIG}\n[profile prod-readonly]\nregion = us-east-1\n`;
	expect(readonlyProfileSection(taken, ACCOUNT, "ReadOnlyAccess")).toBeNull();
	expect(
		readonlyProfileSection(SESSION_CONFIG, "111111111111", "ReadOnlyAccess"),
	).toBeNull();
});

test("ensureAwsReadonlyProfile reads the guard's account from imagen-core and appends once", () => {
	const home = mkdtempSync(join(tmpdir(), "odin-aws-ro-"));
	const hooks = join(
		home,
		".claude/plugins/cache/imagen-internal/imagen-core/abc/hooks",
	);
	mkdirSync(hooks, { recursive: true });
	writeFileSync(
		join(hooks, "aws-guard.json"),
		JSON.stringify({
			prod_account_id: ACCOUNT,
			readonly_role: "ReadOnlyAccess",
		}),
	);
	mkdirSync(join(home, ".aws"));
	const config = join(home, ".aws/config");
	writeFileSync(config, SESSION_CONFIG);
	const saved = process.env.AWS_CONFIG_FILE;
	delete process.env.AWS_CONFIG_FILE;
	try {
		ensureAwsReadonlyProfile(home);
		ensureAwsReadonlyProfile(home);
	} finally {
		if (saved !== undefined) process.env.AWS_CONFIG_FILE = saved;
	}
	const text = readFileSync(config, "utf8");
	expect(text.startsWith(SESSION_CONFIG)).toBe(true);
	expect(text.match(/\[profile prod-readonly\]/g)?.length).toBe(1);
});

test("without imagen-core installed the AWS config is left alone", () => {
	const home = mkdtempSync(join(tmpdir(), "odin-aws-ro-"));
	mkdirSync(join(home, ".aws"));
	writeFileSync(join(home, ".aws/config"), SESSION_CONFIG);
	ensureAwsReadonlyProfile(home);
	expect(readFileSync(join(home, ".aws/config"), "utf8")).toBe(SESSION_CONFIG);
});
