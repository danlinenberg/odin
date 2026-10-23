import { expect, test } from "bun:test";
import { hostGithubLoginFile } from "./host-service";
import {
	HELPERS_AS_USER,
	keptConnectors,
	postToServiceScript,
	SERVICE_CURRENT_SCRIPT,
} from "./host-tokens";

test("tokens go to the user's own service on loopback, from stdin, with no sudo", () => {
	const post = postToServiceScript("/tokens");
	expect(post).toBe(
		'curl -sf -m 30 --data-binary @- "http://127.0.0.1:$((40000 + $(id -u) % 10000 * 2))/tokens" >/dev/null',
	);
	expect(post).not.toContain("sudo");
	// Whether the service runs this Odin's script is read as the user too.
	expect(SERVICE_CURRENT_SCRIPT("odin-dan")).toBe(
		"[ -f /etc/systemd/system/odin-host-odin-dan.service ] && cmp -s /usr/local/lib/odin/host-service.py - && echo current; true",
	);
	// A login is letters, digits and hyphens: nothing a path or a shell reads.
	expect(() => hostGithubLoginFile("../tokens")).toThrow("Not a GitHub login");
});

test("the helper and wrapper go into the user's home under the setup lock", () => {
	expect(HELPERS_AS_USER).toStartWith(
		'mkdir -p "$HOME/.odin" && exec 9>"$HOME/.odin/setup.lock" && flock -w 120 9\n',
	);
	expect(HELPERS_AS_USER).toContain("git-credential-odin");
	expect(HELPERS_AS_USER).toEndWith("\ntrue\n");
	expect(HELPERS_AS_USER).not.toContain("sudo");
});

test("the connectors a tokens file serves: GitHub only with its switch on, whatever token is there for sessions", () => {
	expect(
		keptConnectors({
			slack: "x",
			jira: "j",
			jiraBase: "https://x.atlassian.net",
			github: "gho",
			githubLogin: "dan-work",
			githubAccounts: { "dan-work": "gho" },
		}),
	).toEqual(["slack", "jira"]);
	expect(keptConnectors({ github: "gho", githubConnector: true })).toEqual([
		"github",
	]);
});
