import { describe, expect, test } from "bun:test";
import {
	attachScript,
	httpsCloneUrl,
	issueTicket,
	type RemoteSessionSpec,
	redeemTicket,
	runScript,
	secretsFile,
	tmuxSession,
} from "./session";

const spec: RemoteSessionSpec = {
	instanceId: "i-1",
	user: "ubuntu",
	pane: "pane-1/x",
	reposRoot: "~/repos",
	repoName: "odin",
	cloneUrl: "https://github.com/danlinenberg/odin.git",
	claudeArgs: "--session-id abc",
	prompt: "Fix it's bug",
};

describe("remote session scripts", () => {
	test("tokens become sourced KEY='value' lines, quotes escaped, empty ones dropped", () => {
		expect(
			secretsFile({ CLAUDE_CODE_OAUTH_TOKEN: "sk-a'b", GH_TOKEN: undefined }),
		).toBe("CLAUDE_CODE_OAUTH_TOKEN='sk-a'\\''b'\n");
	});

	test("the run script never names a token, and deletes the token file first", () => {
		const run = runScript(spec, "/dev/shm/odin.X");
		expect(run).not.toContain("sk-");
		expect(run.indexOf("rm -rf '/dev/shm/odin.X'")).toBeLessThan(
			run.indexOf("exec claude"),
		);
		expect(run).toContain(
			`git clone 'https://github.com/danlinenberg/odin.git' "$HOME"/'repos'/'odin'`,
		);
		expect(run).toContain(
			`exec claude --session-id abc "$(printf %s '${Buffer.from("Fix it's bug").toString("base64")}' | base64 -d)"`,
		);
	});

	test("an existing tmux session is reattached; a new one runs the script", () => {
		const attach = attachScript(spec, "/dev/shm/odin.X");
		expect(tmuxSession(spec.pane)).toBe("odin-pane-1-x");
		expect(attach).toStartWith(
			"if tmux has-session -t 'odin-pane-1-x' 2>/dev/null; then",
		);
		expect(attach).toEndWith(
			`exec tmux new-session -s 'odin-pane-1-x' "bash '/dev/shm/odin.X'/run.sh"`,
		);
	});
});

test("a ticket gives its tokens once, and not after two minutes", () => {
	const ticket = issueTicket("A=1\n", 0);
	expect(redeemTicket(ticket, 1000)).toBe("A=1\n");
	expect(redeemTicket(ticket, 1000)).toBeNull();
	expect(redeemTicket(issueTicket("A=1\n", 0), 120_001)).toBeNull();
});

test("ssh and https origins become https clone URLs", () => {
	expect(httpsCloneUrl("git@github.com:o/r.git\n")).toBe(
		"https://github.com/o/r.git",
	);
	expect(httpsCloneUrl("ssh://git@github.com/o/r.git")).toBe(
		"https://github.com/o/r.git",
	);
	expect(httpsCloneUrl("https://github.com/o/r")).toBe(
		"https://github.com/o/r",
	);
	expect(httpsCloneUrl("/local/path")).toBeNull();
});
