import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readOdinConfig,
	updateOdinConfig,
} from "../../lib/trpc/routers/odin-config";
import {
	completeJiraOAuth,
	type HostJiraPair,
	readJiraOAuthResult,
	startJiraOAuth,
} from "./jira-oauth";

process.env.ODIN_CONFIG_PATH = join(
	mkdtempSync(join(tmpdir(), "jira-oauth-")),
	"odin.json",
);
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("a sign-in for the host goes to it whole, and this computer keeps nothing", async () => {
	updateOdinConfig({
		jiraClientId: "cid",
		jiraClientSecret: "csecret",
		jiraRedirectUrl: "https://example.test/jira.html",
		jiraRefreshToken: "mine",
		jiraAccessToken: "mine_access",
	});
	globalThis.fetch = mock(async (url: string) =>
		Response.json(
			String(url).includes("accessible-resources")
				? [{ id: "cloud1", url: "https://site.example" }]
				: { access_token: "host_a", refresh_token: "host_r", expires_in: 3600 },
		),
	) as unknown as typeof fetch;
	const got: HostJiraPair[] = [];
	const { state } = await startJiraOAuth(
		async () => {},
		async (pair) => {
			got.push(pair);
		},
	);
	expect(readJiraOAuthResult(state)?.status).toBe("pending");
	await completeJiraOAuth(`odin://oauth/jira?code=c&state=${state}`);
	expect(readJiraOAuthResult(state)?.status).toBe("connected");
	expect(got).toEqual([
		{
			access_token: "host_a",
			refresh_token: "host_r",
			expires_at: expect.any(Number),
			client_id: "cid",
			client_secret: "csecret",
			cloud_id: "cloud1",
		},
	]);
	const config = readOdinConfig();
	expect(config.jiraRefreshToken).toBe("mine");
	expect(config.jiraAccessToken).toBe("mine_access");
	expect(config.jiraCloudId).toBeUndefined();
});
