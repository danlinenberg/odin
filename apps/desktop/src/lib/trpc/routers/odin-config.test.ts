import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	activeProfileId,
	createProfile,
	DEFAULT_PROFILE_ID,
	deleteProfile,
	listProfiles,
	readOdinConfig,
	renameProfile,
	resolveGithubClientId,
	resolveSlackOAuthApp,
	resolveSlackToken,
	setActiveProfile,
	updateOdinConfig,
} from "./odin-config";

const dir = mkdtempSync(join(tmpdir(), "odin-config-"));
process.env.ODIN_CONFIG_PATH = join(dir, "nested/odin.json");

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	for (const name of [
		"ODIN_SLACK_TOKEN",
		"SLACK_USER_TOKEN",
		"CLAUDE_JIRA_BASE_URL",
		"CLAUDE_JIRA_EMAIL",
		"CLAUDE_JIRA_API_TOKEN",
	])
		delete process.env[name];
});

describe("updateOdinConfig", () => {
	test("creates the file (and its directory), owner-only", () => {
		updateOdinConfig({ slackToken: "xoxp-1" });
		expect(readOdinConfig().slackToken).toBe("xoxp-1");
		// Tokens live here — the file must not be world-readable.
		const mode = statSync(process.env.ODIN_CONFIG_PATH as string).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	test("merges instead of replacing", () => {
		updateOdinConfig({ slackToken: "xoxp-1" });
		updateOdinConfig({ notionToken: "ntn_1" });
		expect(readOdinConfig()).toMatchObject({
			slackToken: "xoxp-1",
			notionToken: "ntn_1",
		});
	});

	test("undefined deletes the key rather than writing null", () => {
		updateOdinConfig({ slackToken: "xoxp-1", notionToken: "ntn_1" });
		updateOdinConfig({ slackToken: undefined });
		const config = readOdinConfig();
		expect("slackToken" in config).toBe(false);
		expect(config.notionToken).toBe("ntn_1");
	});

	test("missing file reads as empty, not a throw", () => {
		expect(readOdinConfig()).toEqual({});
	});
});

describe("credential resolution", () => {
	test("a credential comes from the profile, never the environment", () => {
		// The shell is not a way in: it is ambient and identical for every
		// profile, so honouring it would sign them all into the same account.
		// Signing in is what puts a credential in the profile.
		process.env.ODIN_SLACK_TOKEN = "from-env";
		process.env.SLACK_USER_TOKEN = "also-from-env";
		expect(resolveSlackToken()).toBeNull();
		updateOdinConfig({ slackToken: "from-sign-in" });
		expect(resolveSlackToken()).toBe("from-sign-in");
	});

	test("jira's old API-token trio is dropped, not handed out", () => {
		// Written by a build from before sign-in existed. Reading the file
		// forgets them, so the next write takes the live token out of it.
		const path = process.env.ODIN_CONFIG_PATH as string;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				jiraBaseUrl: "https://team.atlassian.net",
				jiraEmail: "me@team.com",
				jiraToken: "api-token",
				slackToken: "keep-me",
			}),
		);
		const config = readOdinConfig() as Record<string, unknown>;
		expect(config.jiraToken).toBeUndefined();
		expect(config.jiraEmail).toBeUndefined();
		expect(config.jiraBaseUrl).toBeUndefined();
		// Everything else in that profile survives the scrub.
		expect(config.slackToken).toBe("keep-me");
	});
});

describe("resolveGithubClientId", () => {
	test("an unbaked build reads as unconfigured, not as an empty id", () => {
		// The bundler substitutes "" when the build was given no client id; an
		// empty string must not look configured or the device flow starts and
		// fails against GitHub.
		process.env.ODIN_GITHUB_CLIENT_ID_BAKED = "";
		try {
			expect(resolveGithubClientId()).toBeNull();
		} finally {
			delete process.env.ODIN_GITHUB_CLIENT_ID_BAKED;
		}
	});

	test("a baked build needs no local config", () => {
		process.env.ODIN_GITHUB_CLIENT_ID_BAKED = "Iv1.baked";
		try {
			expect(resolveGithubClientId()).toBe("Iv1.baked");
		} finally {
			delete process.env.ODIN_GITHUB_CLIENT_ID_BAKED;
		}
	});

	test("local config wins over a baked build", () => {
		updateOdinConfig({ githubClientId: "Iv1.local" });
		process.env.ODIN_GITHUB_CLIENT_ID_BAKED = "Iv1.baked";
		try {
			expect(resolveGithubClientId()).toBe("Iv1.local");
		} finally {
			delete process.env.ODIN_GITHUB_CLIENT_ID_BAKED;
			updateOdinConfig({ githubClientId: undefined });
		}
	});
});

describe("profiles", () => {
	test("a pre-profiles file reads as the default profile", () => {
		const path = process.env.ODIN_CONFIG_PATH as string;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({ slackToken: "xoxp-old", odinRepo: "/repo" }),
		);
		expect(activeProfileId()).toBe(DEFAULT_PROFILE_ID);
		expect(listProfiles()).toEqual([
			{ id: DEFAULT_PROFILE_ID, name: "Default", active: true },
		]);
		expect(readOdinConfig()).toMatchObject({
			slackToken: "xoxp-old",
			odinRepo: "/repo",
		});
	});

	test("each profile keeps its own credentials", () => {
		updateOdinConfig({ slackToken: "work" });
		const personal = createProfile("Personal");
		// Creating one doesn't switch to it — the work feeds keep running.
		expect(readOdinConfig().slackToken).toBe("work");
		setActiveProfile(personal.id);
		expect(readOdinConfig().slackToken).toBeUndefined();
		updateOdinConfig({ slackToken: "personal" });
		expect(readOdinConfig().slackToken).toBe("personal");
		setActiveProfile(DEFAULT_PROFILE_ID);
		expect(readOdinConfig().slackToken).toBe("work");
	});

	test("machine-wide keys are shared, not copied per profile", () => {
		updateOdinConfig({ odinRepo: "/src/odin", slackToken: "work" });
		const other = createProfile("Personal");
		setActiveProfile(other.id);
		// Update Odin has to keep working in a brand-new profile.
		expect(readOdinConfig().odinRepo).toBe("/src/odin");
		expect(readOdinConfig().slackToken).toBeUndefined();
	});

	test("renaming keeps the id the rest of the app stamped on its rows", () => {
		const personal = createProfile("Personal");
		renameProfile(personal.id, "Home");
		expect(listProfiles().find((p) => p.id === personal.id)?.name).toBe("Home");
	});

	test("deleting the active profile falls back to another one", () => {
		const personal = createProfile("Personal");
		setActiveProfile(personal.id);
		expect(deleteProfile(personal.id)).toBe(DEFAULT_PROFILE_ID);
		expect(activeProfileId()).toBe(DEFAULT_PROFILE_ID);
	});

	test("the last profile can't be deleted", () => {
		expect(() => deleteProfile(activeProfileId())).toThrow();
	});

	test("no profile inherits another's sign-in, or the shell's", () => {
		process.env.ODIN_SLACK_TOKEN = "work-from-shell";

		updateOdinConfig({ slackToken: "work" });
		const personal = createProfile("Personal");
		setActiveProfile(personal.id);
		// A brand-new profile is signed into nothing at all.
		expect(resolveSlackToken()).toBeNull();

		// What you connect here is what you get, and only that.
		updateOdinConfig({ slackToken: "personal" });
		expect(resolveSlackToken()).toBe("personal");
		setActiveProfile(DEFAULT_PROFILE_ID);
		expect(resolveSlackToken()).toBe("work");
	});

	test("the OAuth app is shared, so a new profile can sign in at all", () => {
		// The app says which Slack app Odin *is* — a property of the build, not
		// of an account. A profile without it would offer no sign-in button.
		updateOdinConfig({
			slackClientId: "id",
			slackClientSecret: "secret",
			slackRedirectUrl: "https://odin.example/slack.html",
		});
		const personal = createProfile("Personal");
		setActiveProfile(personal.id);
		expect(resolveSlackOAuthApp()).toEqual({
			clientId: "id",
			clientSecret: "secret",
			redirectUrl: "https://odin.example/slack.html",
		});
	});

	test("an OAuth app written before it was shared is hoisted, not lost", () => {
		const path = process.env.ODIN_CONFIG_PATH as string;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				activeProfileId: "personal",
				profiles: [
					{
						id: DEFAULT_PROFILE_ID,
						name: "Default",
						config: {
							slackClientId: "id",
							slackClientSecret: "secret",
							slackRedirectUrl: "https://odin.example/slack.html",
						},
					},
					{ id: "personal", name: "Personal", config: {} },
				],
			}),
		);
		expect(resolveSlackOAuthApp()?.clientId).toBe("id");
	});
});
