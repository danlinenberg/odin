import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostGithubLoginFile } from "./host-service";
import {
	HELPERS_AS_USER,
	installHelpersScript,
	keptConnectors,
	pruneGithubPairsScript,
	writeGithubPairScript,
	writeTokensScript,
} from "./host-tokens";

test("the host's own sign-in lands as the service's file for its login, owned by odin, mode 0600", () => {
	expect(writeGithubPairScript("odin-dan", "Dan-Work")).toBe(
		`sudo -n sh -c 'umask 077; install -d -m 700 -o odin -g odin /var/lib/odin/odin-dan/github; f=/var/lib/odin/odin-dan/github/dan-work.json; cat > "$f.new" && chown odin:odin "$f.new" && mv "$f.new" "$f"'`,
	);
	expect(writeTokensScript("odin-dan")).toContain(
		"f=/var/lib/odin/odin-dan/tokens.json",
	);
	// A login is letters, digits and hyphens: nothing a path or a shell reads.
	expect(() => hostGithubLoginFile("../tokens")).toThrow("Not a GitHub login");
	expect(() => writeGithubPairScript("odin-dan", "a'b")).toThrow();
});

test("an account turned off loses its sign-in on the host: the prune keeps the allowed ones alone", () => {
	const script = pruneGithubPairsScript("odin-dan", ["Dan-Work", "other"]);
	expect(script).toStartWith(
		"sudo -n sh -c 'cd /var/lib/odin/odin-dan/github 2>/dev/null || exit 0;",
	);
	// The loop itself, run on a folder of sign-ins.
	const dir = mkdtempSync(join(tmpdir(), "odin-prune-"));
	mkdirSync(join(dir, "github"));
	for (const name of ["dan-work", "other", "gone"])
		writeFileSync(join(dir, "github", `${name}.json`), "{}");
	const inner = script
		.replace(/^sudo -n sh -c '/, "")
		.replace(/'$/, "")
		.replace("/var/lib/odin/odin-dan/github", join(dir, "github"));
	execFileSync("sh", ["-c", inner]);
	expect(readdirSync(join(dir, "github")).sort()).toEqual([
		"dan-work.json",
		"other.json",
	]);
	execFileSync("sh", [
		"-c",
		pruneGithubPairsScript("odin-dan", [])
			.replace(/^sudo -n sh -c '/, "")
			.replace(/'$/, "")
			.replace("/var/lib/odin/odin-dan/github", join(dir, "github")),
	]);
	expect(readdirSync(join(dir, "github"))).toEqual([]);
});

test("the helper and wrapper go into the user's home as that user, under the setup lock", () => {
	expect(installHelpersScript("odin-dan")).toBe(
		"if id -u 'odin-dan' >/dev/null 2>&1; then sudo -n -u 'odin-dan' -H bash; fi",
	);
	expect(HELPERS_AS_USER).toStartWith(
		'mkdir -p "$HOME/.odin" && exec 9>"$HOME/.odin/setup.lock" && flock -w 120 9\n',
	);
	expect(HELPERS_AS_USER).toContain("git-credential-odin");
	expect(HELPERS_AS_USER).toEndWith("\ntrue\n");
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
