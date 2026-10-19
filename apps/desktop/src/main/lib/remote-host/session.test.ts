import { describe, expect, test } from "bun:test";
import {
	attachScript,
	hostFiles,
	hostNote,
	httpsCloneUrl,
	issueTicket,
	mainCheckoutOf,
	parseSetupToken,
	planLimitSettings,
	type RemoteSessionSpec,
	redeemTicket,
	repoNameOf,
	runScript,
	secretsFile,
	sh,
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
			run.indexOf("claude --settings"),
		);
		expect(run).toContain(
			`git clone 'https://github.com/danlinenberg/odin.git' "$HOME"/'repos'/'odin'`,
		);
		expect(run).toContain(
			`\nclaude --settings ${sh(planLimitSettings)} --session-id abc "$(printf %s '${Buffer.from("Fix it's bug").toString("base64")}' | base64 -d)"`,
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

test("the token comes out of setup-token's screen, colors and all", () => {
	expect(
		parseSetupToken(
			"\x1b[32mYour token:\x1b[0m\r\n\x1b[1msk-ant-oat01-Ab_c-9\x1b[0m\r\nStore it",
		),
	).toBe("sk-ant-oat01-Ab_c-9");
	expect(parseSetupToken("cancelled")).toBeNull();
});

test("laptop files in the prompt are copied, and the prompt names the copies", () => {
	const { prompt, files } = hostFiles(
		"See /Users/dan/.odin/attachments/a.png. Not /Users/dan/gone.txt",
		"ubuntu",
		(path) => path.endsWith("a.png"),
	);
	expect(files).toEqual([
		{
			local: "/Users/dan/.odin/attachments/a.png",
			remote: ".odin/files/0-a.png",
		},
	]);
	expect(prompt).toBe(
		"See /home/ubuntu/.odin/files/0-a.png. Not /Users/dan/gone.txt",
	);
});

test("a session with a repo starts in its own worktree, with Odin's port", () => {
	const run = runScript(
		{ ...spec, pane: "abcdef1234", odinPane: "pane-9" },
		"/d",
	);
	expect(run).toContain(
		"curl -sf -m 2 http://127.0.0.1:47187/health >/dev/null && ODIN_PORT=47187 || ODIN_PORT=47189",
	);
	expect(run).toContain("export ODIN_PORT ODIN_PANE_ID='pane-9'");
	expect(run).toContain(
		`git -C "$HOME"/'repos'/'odin' worktree add -q -b 'odin/abcdef12' "$HOME"/'repos'/'odin'/.worktrees/'odin-abcdef12' origin/HEAD`,
	);
});

test("a clone URL names its repo", () => {
	expect(repoNameOf("https://github.com/o/odin.git")).toBe("odin");
	expect(repoNameOf("https://github.com/o/odin/")).toBe("odin");
});

test("a gone session worktree still names its repo", () => {
	expect(mainCheckoutOf("/Users/d/dev/x/.worktrees/so-we-have-i4cj")).toBe(
		"/Users/d/dev/x",
	);
	expect(mainCheckoutOf("/Users/d/dev/x")).toBe("/Users/d/dev/x");
});

test("a task with no repo gets the known repos and the commands for its worktree", () => {
	const note = hostNote({
		user: "ubuntu",
		name: "odin-remote",
		repoName: null,
		pane: "0d202ff3aa",
		known: ["https://github.com/o/a.git"],
	});
	expect(note).toContain("- https://github.com/o/a.git");
	expect(note).toContain(
		"worktree add -b odin/0d202ff3 /home/ubuntu/repos/<name>/.worktrees/odin-0d202ff3",
	);
});

test("the host falls back to the API key only while the plan is limited", () => {
	const run = runScript(spec, "/d");
	expect(run).toContain(
		'then export ANTHROPIC_API_KEY="$ODIN_FALLBACK_API_KEY"; else unset ANTHROPIC_API_KEY; fi',
	);
	expect(run.indexOf("unset ODIN_FALLBACK_API_KEY")).toBeLessThan(
		run.indexOf("claude --settings"),
	);
	expect(run).toContain('ANTHROPIC_API_KEY="$fallback" exec claude --settings');
	const hooks = JSON.parse(planLimitSettings).hooks;
	expect(hooks.Stop[0].hooks[0].command).toBe("python3 ~/.odin/turn-end.py");
	expect(hooks.StopFailure[0].hooks[0].command).toBe(
		"ODIN_TURN=failed python3 ~/.odin/turn-end.py",
	);
});

test("files sent later get a prefix, so they never overwrite earlier copies", () => {
	expect(
		hostFiles("/Users/d/a.png", "ubuntu", () => true, "1700-").files[0]?.remote,
	).toBe(".odin/files/1700-0-a.png");
});
