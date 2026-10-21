import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	attachScript,
	CLAUDE_LOGIN_SCRIPT,
	HOST_NOTIFY_HOOK,
	hostFiles,
	hostNote,
	hostSettings,
	httpsCloneUrl,
	issueTicket,
	linuxUserName,
	MEMORY_LIMIT_SCRIPT,
	mainCheckoutOf,
	parseClaudeLogin,
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
			`\nclaude --settings ${sh(hostSettings)} --session-id abc "$(printf %s '${Buffer.from("Fix it's bug").toString("base64")}' | base64 -d)"`,
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
		expect(
			attachScript({ ...spec, fresh: true }, "/dev/shm/odin.X"),
		).toStartWith(
			"tmux kill-session -t 'odin-pane-1-x' 2>/dev/null\nif tmux has-session",
		);
	});

	test("the run script starts over under its own memory cap, or runs uncapped without systemd", () => {
		expect(runScript(spec, "/d")).toStartWith(MEMORY_LIMIT_SCRIPT);
		expect(MEMORY_LIMIT_SCRIPT).toContain(
			"systemd-run --user --scope --quiet -p MemoryMax=$max -p MemorySwapMax=0",
		);
		expect(MEMORY_LIMIT_SCRIPT).toContain('exec $limit bash "$0"');
		const dir = mkdtempSync(join(tmpdir(), "odin-mem-"));
		try {
			writeFileSync(join(dir, "run.sh"), `${MEMORY_LIMIT_SCRIPT}\necho ran`);
			const out = execFileSync("/bin/bash", [join(dir, "run.sh")], {
				env: { PATH: "/usr/bin:/bin", HOME: dir },
			}).toString();
			expect(out).toBe("ran\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a reply that resumes a live tmux session is pasted into it", () => {
		const attach = attachScript(
			{ ...spec, claudeArgs: "--resume abc", prompt: "go on" },
			"/d",
		);
		expect(attach).toContain(
			`printf %s '${Buffer.from("go on").toString("base64")}' | base64 -d | tmux load-buffer`,
		);
		expect(attachScript(spec, "/d")).not.toContain("load-buffer");
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

test("the sign-in comes out of Claude's saved credentials", () => {
	expect(
		parseClaudeLogin(
			JSON.stringify({
				claudeAiOauth: {
					refreshToken: "rt",
					scopes: ["user:profile", "user:inference"],
				},
			}),
			"id1",
		),
	).toEqual({
		refreshToken: "rt",
		scopes: "user:profile user:inference",
		id: "id1",
	});
	expect(parseClaudeLogin("", "id1")).toBeNull();
});

test("the host signs in once per new sign-in, then drops the setup token", () => {
	const home = mkdtempSync(join(tmpdir(), "odin-login-"));
	mkdirSync(join(home, "bin"));
	writeFileSync(
		join(home, "bin", "claude"),
		`#!/bin/sh\necho "$CLAUDE_CODE_OAUTH_REFRESH_TOKEN $CLAUDE_CODE_OAUTH_SCOPES \${CLAUDE_CODE_OAUTH_TOKEN:-none}" >> "$HOME/calls"\n`,
		{ mode: 0o755 },
	);
	const run = (id: string) =>
		execFileSync(
			"bash",
			[
				"-c",
				`${CLAUDE_LOGIN_SCRIPT}\necho "token=\${CLAUDE_CODE_OAUTH_TOKEN:-none}"`,
			],
			{
				env: {
					HOME: home,
					PATH: `${home}/bin:/usr/bin:/bin`,
					CLAUDE_CODE_OAUTH_TOKEN: "old",
					ODIN_CLAUDE_REFRESH_TOKEN: "rt",
					ODIN_CLAUDE_SCOPES: "user:profile",
					ODIN_CLAUDE_LOGIN_ID: id,
				},
			},
		).toString();
	expect(run("a")).toBe("token=none\n");
	expect(run("a")).toBe("token=none\n");
	run("b");
	expect(readFileSync(join(home, "calls"), "utf8")).toBe(
		"rt user:profile none\nrt user:profile none\n",
	);
	rmSync(home, { recursive: true, force: true });
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
		"p=$((40000 + $(id -u) % 10000 * 2)); curl -sf -m 2 http://127.0.0.1:$p/health >/dev/null && ODIN_PORT=$p || ODIN_PORT=$((p + 1))",
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
	// The limit note lands whole: the laptop's plan-limit hook, synced to the
	// host, writes the same file at the same moment.
	const hook = run.match(
		/printf %s '([^']+)' \| base64 -d > "\$HOME\/\.odin\/turn-end\.py"/,
	);
	const turnEnd = Buffer.from(hook?.[1] ?? "", "base64").toString();
	expect(turnEnd).toContain("os.replace(");
	expect(turnEnd).not.toContain('plan-limit.json"), "w")');
	const hooks = JSON.parse(hostSettings).hooks;
	expect(hooks.Stop[0].hooks[0].command).toBe("python3 ~/.odin/turn-end.py");
	expect(hooks.StopFailure[0].hooks[0].command).toBe(
		"ODIN_TURN=failed python3 ~/.odin/turn-end.py",
	);
});

test("the host reports Working and Done to the card through Odin's notify hook", () => {
	const hooks = JSON.parse(hostSettings).hooks;
	expect(hooks.UserPromptSubmit[0].hooks[0].command).toContain(
		`$HOME/${HOST_NOTIFY_HOOK}`,
	);
	expect(hooks.Stop[1].hooks[0].command).toContain(`$HOME/${HOST_NOTIFY_HOOK}`);
});

test("files sent later get a prefix, so they never overwrite earlier copies", () => {
	expect(
		hostFiles("/Users/d/a.png", "ubuntu", () => true, "1700-").files[0]?.remote,
	).toBe(".odin/files/1700-0-a.png");
});

test("each Odin user gets a Linux user name of their own", () => {
	expect(linuxUserName("DanLinenberg")).toBe("odin-danlinenberg");
	expect(linuxUserName("dan.l@x")).toBe("odin-dan-l-x");
	expect(linuxUserName("")).toBe("odin-user");
	expect(linuxUserName("a".repeat(40))).toHaveLength(32);
});
