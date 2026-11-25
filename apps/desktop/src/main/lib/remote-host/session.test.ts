import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ODIN_TASK_RULE, VOICE_RULE } from "../../../shared/constants";
import {
	SLACK_ALLOW_RULES,
	SLACK_DENY_RULES,
} from "../agent-setup/slack-tools";
import { removeWorktreeScript } from "./bring-home";
import {
	attachScript,
	BRANCH_RENAME_RULE,
	branchKey,
	CLAUDE_LOGIN_SCRIPT,
	CONVERSATION_DIR,
	CUT_OFF_TURN,
	GH_WRAPPER,
	GIT_CREDENTIAL_HELPER,
	GITHUB_HELPERS_SCRIPT,
	HOST_NOTIFY_HOOK,
	hostEnvScript,
	hostFiles,
	hostNote,
	hostSettings,
	httpsCloneUrl,
	issueTicket,
	linuxUserName,
	MEMORY_LIMIT_SCRIPT,
	MEMORY_PRESSURE_WATCHER,
	mainCheckoutOf,
	NODE_ON_PATH,
	nodeInstallScript,
	PROMPT_TAKEN,
	parseClaudeLogin,
	pruneInstallScript,
	prunePass,
	RECORD_LIMIT_HIT,
	type RemoteSessionSpec,
	reconnectSpec,
	redeemTicket,
	repoNameOf,
	runScript,
	SESSION_CLEANUP,
	SKIP_FIRST_RUN,
	secretsFile,
	sendsConversation,
	sentConversation,
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
	test("every Claude the host starts skips permission prompts, like a session on this computer", () => {
		const run = runScript(
			{ ...spec, claudeArgs: "--resume abc" },
			"/dev/shm/odin.X",
		);
		const starts = run.match(/\bclaude --[^\s]+/g) ?? [];
		// The first start, its fresh fallback, the idle watcher's three resumes
		// and the two plan-limit resumes.
		expect(starts.length).toBe(7);
		for (const start of starts) {
			expect(start).toBe("claude --dangerously-skip-permissions");
		}
	});

	test("a resume whose conversation the host never saved starts fresh under the same id, with its prompt", () => {
		const run = runScript(
			{ ...spec, claudeArgs: "--resume abc" },
			"/dev/shm/odin.X",
		);
		expect(run).toContain(
			`if ls "$HOME"/.claude/projects/*/'abc.jsonl' >/dev/null 2>&1; then claude --dangerously-skip-permissions --settings ${sh(hostSettings)} --resume abc "\${p[@]}"; else`,
		);
		expect(run).toContain(
			`claude --dangerously-skip-permissions --settings ${sh(hostSettings)} --session-id abc "\${p[@]}"; fi`,
		);
		// The prompt is in p before either start.
		expect(run.indexOf("p=(")).toBeLessThan(run.indexOf("if ls"));
	});

	test("tokens become sourced KEY='value' lines, quotes escaped, empty ones dropped", () => {
		expect(
			secretsFile({
				CLAUDE_CODE_OAUTH_TOKEN: "sk-a'b",
				ODIN_FALLBACK_API_KEY: undefined,
			}),
		).toBe("CLAUDE_CODE_OAUTH_TOKEN='sk-a'\\''b'\n");
	});

	test("the run script never names a token, and deletes the token file first", () => {
		const run = runScript(spec, "/dev/shm/odin.X");
		expect(run).not.toContain("sk-");
		expect(run.indexOf("rm -rf '/dev/shm/odin.X'")).toBeLessThan(
			run.indexOf("claude --dangerously-skip-permissions --settings"),
		);
		expect(run).toContain(
			`git clone 'https://github.com/danlinenberg/odin.git' "$HOME"/'repos'/'odin'`,
		);
		expect(run).toContain(
			`\np=()\np=("$(printf %s '${Buffer.from("Fix it's bug").toString("base64")}' | base64 -d)")\nclaude --dangerously-skip-permissions --settings ${sh(hostSettings)} --session-id abc "\${p[@]}"\n`,
		);
	});

	test("no GitHub token is baked into a session: git and gh get the current one from the host service", () => {
		const run = runScript({ ...spec, githubLogin: "dan-work" }, "/d");
		expect(run).not.toContain("GH_TOKEN");
		expect(run).not.toContain("GIT_CONFIG_");
		expect(run).toContain("export ODIN_GITHUB_LOGIN='dan-work'");
		// The helper and wrapper are on disk before the clone needs them, under the setup lock.
		expect(run).toContain(GITHUB_HELPERS_SCRIPT);
		const helpers = run.indexOf(GITHUB_HELPERS_SCRIPT);
		expect(helpers).toBeGreaterThan(run.indexOf("flock -w 120 9"));
		expect(helpers).toBeLessThan(run.indexOf("git clone"));
		expect(GITHUB_HELPERS_SCRIPT).toContain(
			'credential.https://github.com.helper "!$HOME/.odin/bin/git-credential-odin"',
		);
		expect(GITHUB_HELPERS_SCRIPT).toContain(
			'base64 -d > "$HOME/.local/bin/gh".$$',
		);
		expect(runScript(spec, "/d")).not.toContain("ODIN_GITHUB_LOGIN");
	});

	test("an idle Claude is stopped and resumed on a key, inside the same tmux session", () => {
		const run = runScript(spec, "/d");
		const watcher = run.indexOf("#{window_activity}");
		const start = run.indexOf(
			"claude --dangerously-skip-permissions --settings",
		);
		expect(watcher).toBeGreaterThan(-1);
		expect(watcher).toBeLessThan(start);
		expect(run.indexOf("read -e -r", start)).toBeGreaterThan(start);
		expect(run).toContain(`--resume ${sh(spec.pane)}`);
		execFileSync("bash", ["-n"], { input: run });
	});

	test("sessions take turns at setup and let go before Claude starts", () => {
		const run = runScript(spec, "/d");
		const lock = run.indexOf("flock -w 120 9");
		expect(lock).toBeGreaterThan(-1);
		expect(lock).toBeLessThan(run.indexOf("git clone"));
		const unlock = run.indexOf("\nexec 9>&-\n");
		expect(unlock).toBeGreaterThan(run.indexOf("turn-end.py"));
		expect(unlock).toBeLessThan(
			run.indexOf("claude --dangerously-skip-permissions --settings"),
		);
	});

	test("an existing tmux session is reattached; a new one runs the script", () => {
		const attach = attachScript(spec, "/dev/shm/odin.X");
		expect(tmuxSession(spec.pane)).toBe("odin-pane-1-x");
		// The window follows the largest attached client, not a stale small one.
		expect(attach).toStartWith(
			"tmux set-option -g window-size largest 2>/dev/null\n",
		);
		expect(attach).toContain(
			"if tmux has-session -t 'odin-pane-1-x' 2>/dev/null; then",
		);
		// The live viewer is the only client: an older, wider one left attached
		// would size the window past the terminal and garble it.
		expect(attach).toContain("exec tmux attach -d -t 'odin-pane-1-x'; fi");
		expect(attach).toEndWith(
			`exec tmux new-session -s 'odin-pane-1-x' "bash '/dev/shm/odin.X'/run.sh"`,
		);
		expect(attachScript({ ...spec, fresh: true }, "/dev/shm/odin.X")).toContain(
			"tmux kill-session -t 'odin-pane-1-x' 2>/dev/null\nif tmux has-session",
		);
	});

	test("tmux passes Claude's copy (OSC 52) on to Odin, before the attach", () => {
		const attach = attachScript(spec, "/d");
		const attachAt = attach.indexOf("exec tmux attach");
		for (const line of [
			"tmux set-option -g set-clipboard on 2>/dev/null\n",
			"tmux set-option -g allow-passthrough on 2>/dev/null\n",
		]) {
			expect(attach).toContain(line);
			expect(attach.indexOf(line)).toBeLessThan(attachAt);
		}
	});

	test("the run script starts over under its own memory cap, or runs uncapped without systemd", () => {
		expect(runScript(spec, "/d")).toStartWith(MEMORY_LIMIT_SCRIPT);
		expect(MEMORY_LIMIT_SCRIPT).toContain(
			"systemd-run --user --scope --quiet -p MemoryMax=$max -p MemorySwapMax=0",
		);
		expect(MEMORY_LIMIT_SCRIPT).toContain(
			'$limit -p OOMPolicy=continue true >/dev/null 2>&1 && limit="$limit -p OOMPolicy=continue"',
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

	test("a capped session under memory pressure loses its biggest process", () => {
		expect(runScript(spec, "/d")).toContain(MEMORY_PRESSURE_WATCHER);
		expect(MEMORY_PRESSURE_WATCHER).toContain("logger -t odin-memory");
		const dir = mkdtempSync(join(tmpdir(), "odin-psi-"));
		const big = spawnSync("/bin/sh", [
			"-c",
			"sleep 60 >/dev/null 2>&1 & echo $!",
		])
			.stdout.toString()
			.trim();
		try {
			writeFileSync(
				join(dir, "memory.pressure"),
				"some avg10=97.00 avg60=50.00 avg300=10.00 total=1\nfull avg10=92.31 avg60=40.00 avg300=9.00 total=1\n",
			);
			writeFileSync(join(dir, "memory.max"), "1000\n");
			writeFileSync(join(dir, "cgroup.procs"), `${big}\n`);
			execFileSync("/bin/bash", ["-c", `${MEMORY_PRESSURE_WATCHER}\nsleep 7`], {
				env: { PATH: "/usr/bin:/bin", ODIN_CGROUP: dir },
			});
			expect(spawnSync("kill", ["-0", big]).status).not.toBe(0);
		} finally {
			spawnSync("kill", [big]);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15000);

	// Session scopes are Linux cgroups, and macOS has no setsid to start the test's processes.
	test.skipIf(process.platform !== "linux")(
		"a run script that ends stops what it left running in its scope, and nothing outside it",
		() => {
			expect(runScript(spec, "/d")).toContain(
				`${MEMORY_PRESSURE_WATCHER}\n${SESSION_CLEANUP}\n`,
			);
			const dir = mkdtempSync(join(tmpdir(), "odin-scope-"));
			const start = () =>
				spawnSync("/bin/sh", [
					"-c",
					"setsid sleep 60 >/dev/null 2>&1 & echo $!",
				])
					.stdout.toString()
					.trim();
			const left = start();
			const outside = start();
			try {
				writeFileSync(join(dir, "cgroup.procs"), `${left}\n`);
				execFileSync("/bin/bash", ["-c", `${SESSION_CLEANUP}\ntrue`], {
					env: { PATH: "/usr/bin:/bin", ODIN_CGROUP: dir },
				});
				expect(spawnSync("kill", ["-0", left]).status).not.toBe(0);
				expect(spawnSync("kill", ["-0", outside]).status).toBe(0);
			} finally {
				spawnSync("kill", [left, outside]);
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	test("outside a session scope the run script leaves every process alone", () => {
		const out = execFileSync(
			"/bin/bash",
			["-c", `${SESSION_CLEANUP}\ntrap -p EXIT`],
			{ env: { PATH: "/usr/bin:/bin" } },
		).toString();
		expect(out).toBe("");
	});

	test("the host's /etc/environment fills in what the session lacks, never PATH or a name it has", () => {
		expect(runScript(spec, "/d")).toContain(
			`${MEMORY_LIMIT_SCRIPT}\n${hostEnvScript()}\n`,
		);
		const dir = mkdtempSync(join(tmpdir(), "odin-env-"));
		try {
			const file = join(dir, "environment");
			writeFileSync(
				file,
				[
					'PATH="/sbin"',
					"# a comment",
					"CLAUDE_CREDENTIALS_SECRET=/prod/services/odin-host-claude",
					'AWS_CONFIG_FILE="/etc/aws/config"',
					"KEPT=host",
					"bad-name=x",
					"NO_NEWLINE='last'",
				].join("\n"),
			);
			const out = execFileSync(
				"/bin/bash",
				[
					"-c",
					`${hostEnvScript(file)}\nprintf '%s|' "$PATH" "$CLAUDE_CREDENTIALS_SECRET" "$AWS_CONFIG_FILE" "$KEPT" "$NO_NEWLINE"`,
				],
				{ env: { PATH: "/usr/bin:/bin", KEPT: "session" } },
			).toString();
			expect(out).toBe(
				"/usr/bin:/bin|/prod/services/odin-host-claude|/etc/aws/config|session|last|",
			);
			// No file: nothing happens and the script goes on.
			expect(
				spawnSync("/bin/bash", [
					"-c",
					`${hostEnvScript(join(dir, "none"))}\necho on`,
				]).stdout.toString(),
			).toBe("on\n");
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

	test("a Resume with no prompt says Continue only to a turn that was cut off", () => {
		const run = runScript(
			{ ...spec, claudeArgs: "--resume abc", prompt: null },
			"/d",
		);
		expect(run).toContain(
			`\np=()\n[ "\${#p[@]}" -eq 0 ] && python3 -c ${sh(CUT_OFF_TURN)} 'abc' 2>/dev/null && p=(Continue)\n`,
		);
		expect(run).toContain(`--resume abc "\${p[@]}"; else`);
		const home = mkdtempSync(join(tmpdir(), "odin-cut-"));
		const cutOff = (...entries: object[]) => {
			mkdirSync(join(home, ".claude/projects/-home-x"), { recursive: true });
			writeFileSync(
				join(home, ".claude/projects/-home-x/s.jsonl"),
				`${entries.map((e) => JSON.stringify(e)).join("\n")}\nnot json\n`,
			);
			try {
				execFileSync("python3", ["-c", CUT_OFF_TURN, "s"], {
					env: { HOME: home, PATH: process.env.PATH },
				});
				return true;
			} catch {
				return false;
			}
		};
		const said = (stop_reason: string | null) => ({
			type: "assistant",
			message: { stop_reason, content: [{ type: "text", text: "x" }] },
		});
		const user = (content: unknown) => ({ type: "user", message: { content } });
		try {
			expect(cutOff(said("tool_use"), user([{ type: "tool_result" }]))).toBe(
				true,
			);
			expect(cutOff(said("tool_use"))).toBe(true);
			expect(cutOff(said(null))).toBe(true);
			expect(cutOff(said("end_turn"), user("next task"))).toBe(true);
			expect(cutOff(user("hi"), said("end_turn"))).toBe(false);
			expect(
				cutOff(
					said("end_turn"),
					{ type: "system" },
					{ type: "user", isMeta: true },
				),
			).toBe(false);
			expect(
				cutOff(
					said("tool_use"),
					user([{ type: "text", text: "[Request interrupted by user]" }]),
				),
			).toBe(false);
			rmSync(join(home, ".claude"), { recursive: true });
			expect(cutOff()).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

/**
 * The helper and wrapper, run for real with a fake curl on PATH that records
 * what it was asked and answers a token: the service's side of the exchange.
 */
function fakeCurl(answer: string) {
	const dir = mkdtempSync(join(tmpdir(), "odin-fake-curl-"));
	const log = join(dir, "log");
	mkdirSync(join(dir, "bin"));
	writeFileSync(
		join(dir, "bin", "curl"),
		`#!/bin/sh\necho "args: $*" >> "$FAKE_LOG"\necho "stdin: $(cat)" >> "$FAKE_LOG"\n${answer}\n`,
		{ mode: 0o755 },
	);
	const run = (script: string, args: string[], input: string, env = {}) =>
		execFileSync("sh", [script, ...args], {
			input,
			encoding: "utf8",
			env: {
				PATH: `${join(dir, "bin")}:${process.env.PATH}`,
				FAKE_LOG: log,
				HOME: dir,
				...env,
			},
		});
	const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
	return { dir, run, calls };
}

test("git's helper asks the service for the token of the session's account, or the repo owner's", () => {
	const curl = fakeCurl("printf gho_fresh");
	const helper = join(curl.dir, "helper.sh");
	writeFileSync(helper, GIT_CREDENTIAL_HELPER);
	const out = curl.run(
		helper,
		["get"],
		"protocol=https\nhost=github.com\npath=acme/odin.git\n",
		{ ODIN_GITHUB_LOGIN: "dan-work" },
	);
	expect(out).toBe("username=x-access-token\npassword=gho_fresh\n");
	expect(curl.calls()).toContain(
		"/token?service=github&login=dan-work&owner=acme",
	);
	// GitHub refused it: the token goes back to the service, on stdin, never on the command line.
	curl.run(
		helper,
		["erase"],
		"protocol=https\nhost=github.com\npath=acme/odin.git\nusername=x-access-token\npassword=gho_refused\n",
	);
	const erase = curl.calls().split("\n").slice(2).join("\n");
	expect(erase).toContain("--data-binary @-");
	expect(erase).toContain("login=&owner=acme");
	expect(erase).toContain("stdin: gho_refused");
	expect(erase).not.toContain("args: ".concat("gho_refused"));
});

test("git's helper answers nothing when the service has no token, so git says so", () => {
	const curl = fakeCurl("exit 22");
	const helper = join(curl.dir, "helper.sh");
	writeFileSync(helper, GIT_CREDENTIAL_HELPER);
	expect(curl.run(helper, ["get"], "host=github.com\n")).toBe("");
});

test("gh runs with the service's token, keeps an older session's own when there is none, and finds the real gh", () => {
	const curl = fakeCurl("printf gho_fresh");
	const wrapper = join(curl.dir, "bin", "gh");
	writeFileSync(wrapper, GH_WRAPPER, { mode: 0o755 });
	const real = '#!/bin/sh\necho "token=$GH_TOKEN args=$*"\n';
	mkdirSync(join(curl.dir, ".odin", "bin"), { recursive: true });
	writeFileSync(join(curl.dir, ".odin", "bin", "gh"), real, { mode: 0o755 });
	expect(curl.run(wrapper, ["pr", "list"], "")).toBe(
		"token=gho_fresh args=pr list\n",
	);
	rmSync(join(curl.dir, ".odin"), { recursive: true });
	// No gh of Odin's own: the next gh on PATH, not this wrapper again.
	mkdirSync(join(curl.dir, "sys"));
	writeFileSync(join(curl.dir, "sys", "gh"), real, { mode: 0o755 });
	const stale = fakeCurl("exit 22");
	const out = execFileSync("bash", [wrapper, "auth", "status"], {
		encoding: "utf8",
		env: {
			PATH: `${join(stale.dir, "bin")}:${join(curl.dir, "bin")}:${join(curl.dir, "sys")}:${process.env.PATH}`,
			FAKE_LOG: join(stale.dir, "log"),
			HOME: curl.dir,
			GH_TOKEN: "gho_from_launch",
		},
	});
	expect(out).toBe("token=gho_from_launch args=auth status\n");
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

test("a session resumed after Done gets its worktree back on its own branch", () => {
	const root = mkdtempSync(join(tmpdir(), "session-wt-"));
	const bash = (cwd: string, cmd: string) =>
		execFileSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
	const origin = join(root, "origin.git");
	bash(root, `git init -q --bare -b main ${origin}`);
	bash(
		root,
		`git clone -q ${origin} seed 2>/dev/null && cd seed && echo base > a.txt && git -c user.name=t -c user.email=t@t add a.txt && git -c user.name=t -c user.email=t@t commit -q -m base && git push -q origin main`,
	);
	bash(root, `git clone -q ${origin} repos/x`);
	const worktree = join(root, "repos", "x", ".worktrees", "odin-abcdef12");
	const line = runScript(
		{
			...spec,
			reposRoot: join(root, "repos"),
			repoName: "x",
			pane: "abcdef1234",
		},
		"/d",
	)
		.split("\n")
		.find((l) => l.includes("worktree add"));
	// A first start: a new branch from origin/HEAD.
	bash(root, line ?? "false");
	expect(bash(worktree, "git branch --show-current").trim()).toBe(
		"odin/abcdef12",
	);
	// Done removed the worktree and kept the branch; the Resume re-adds it.
	bash(root, `git -C repos/x worktree remove --force ${worktree}`);
	bash(root, line ?? "false");
	expect(existsSync(worktree)).toBe(true);
	expect(bash(worktree, "git branch --show-current").trim()).toBe(
		"odin/abcdef12",
	);
});

test("a branch the agent renamed comes back on a Resume after Done", () => {
	const root = mkdtempSync(join(tmpdir(), "session-wt-named-"));
	const bash = (cwd: string, cmd: string) =>
		execFileSync("bash", ["-c", cmd], {
			cwd,
			encoding: "utf8",
			env: { ...process.env, HOME: root },
		});
	const g = "git -c user.name=t -c user.email=t@t";
	const origin = join(root, "origin.git");
	bash(root, `git init -q --bare -b main ${origin}`);
	bash(
		root,
		`git clone -q ${origin} seed 2>/dev/null && cd seed && echo base > a.txt && ${g} add a.txt && ${g} commit -q -m base && git push -q origin main`,
	);
	bash(root, `git clone -q ${origin} repos/x`);
	const worktree = join(root, "repos", "x", ".worktrees", "odin-abcdef12");
	const line =
		runScript(
			{
				...spec,
				reposRoot: join(root, "repos"),
				repoName: "x",
				pane: "abcdef1234",
			},
			"/d",
		)
			.split("\n")
			.find((l) => l.includes("worktree add")) ?? "false";
	bash(root, line);
	// The agent names its branch after the work and commits.
	bash(
		worktree,
		`git branch -m fix/login-timeout && echo w > b.txt && ${g} add b.txt && ${g} commit -q -m work`,
	);
	bash(root, removeWorktreeScript("abcdef1234", join(root, "repos")));
	expect(existsSync(worktree)).toBe(false);
	expect(
		bash(
			root,
			`git -C repos/x config --get ${branchKey("odin-abcdef12")}`,
		).trim(),
	).toBe("fix/login-timeout");
	bash(root, line);
	expect(bash(worktree, "git branch --show-current").trim()).toBe(
		"fix/login-timeout",
	);
	expect(bash(worktree, "git log -1 --format=%s").trim()).toBe("work");
});

test("the host note tells the agent to name its placeholder branch after the work", () => {
	for (const repoName of ["odin", null])
		expect(
			hostNote({ user: "ubuntu", name: "h", repoName, pane: "0d202ff3aa" }),
		).toContain(BRANCH_RENAME_RULE);
});

test("a Resume starts Claude in the folder its conversation is filed under", () => {
	const run = runScript({ ...spec, claudeArgs: "--resume abc" }, "/d");
	const line = `d=$(python3 -c ${sh(CONVERSATION_DIR)} 'abc' 2>/dev/null) && [ -d "$d" ] && cd "$d"; true`;
	expect(run.indexOf(line)).toBeGreaterThan(
		run.indexOf("cd \"$HOME\"/'repos'/'odin'/.worktrees"),
	);
	expect(run.indexOf(line)).toBeLessThan(
		run.indexOf("claude --dangerously-skip-permissions --settings"),
	);
	expect(runScript(spec, "/d")).not.toContain(sh(CONVERSATION_DIR));
	const home = mkdtempSync(join(tmpdir(), "odin-dir-"));
	try {
		mkdirSync(join(home, ".claude/projects/-home-ubuntu-repos"), {
			recursive: true,
		});
		writeFileSync(
			join(home, ".claude/projects/-home-ubuntu-repos/abc.jsonl"),
			`${JSON.stringify({ type: "mode" })}\nnot json\n${JSON.stringify({ cwd: "/Users/me/x" })}\n${JSON.stringify({ cwd: "/home/ubuntu/repos" })}\n${JSON.stringify({ cwd: "/home/ubuntu/repos/x/.worktrees/y" })}\n`,
		);
		const dir = (id: string) =>
			execFileSync("python3", ["-c", CONVERSATION_DIR, id], {
				env: { HOME: home, PATH: process.env.PATH },
				encoding: "utf8",
			}).trim();
		expect(dir("abc")).toBe("/home/ubuntu/repos");
		expect(() => dir("missing")).toThrow();
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a Resume files a conversation sent from this computer where Claude starts, or over an older copy the host user has", () => {
	const line =
		runScript({ ...spec, claudeArgs: "--resume abc" }, "/d")
			.split("\n")
			.find((l) => l.includes(sentConversation("abc"))) ?? "false";
	expect(runScript(spec, "/d")).not.toContain(sentConversation("abc"));
	// Real path: bash's $PWD has no symlinks (macOS /tmp is /private/tmp).
	const home = realpathSync(mkdtempSync(join(tmpdir(), "odin-sent-")));
	const start = join(home, "repos", "x");
	mkdirSync(join(home, ".odin"), { recursive: true });
	mkdirSync(start, { recursive: true });
	const run = () =>
		execFileSync("bash", ["-c", line], {
			cwd: start,
			env: { HOME: home, PATH: process.env.PATH },
		});
	const filed = join(
		home,
		".claude/projects",
		start.replace(/[^A-Za-z0-9]/g, "-"),
		"abc.jsonl",
	);
	try {
		writeFileSync(join(home, sentConversation("abc")), "sent\n");
		run();
		expect(readFileSync(filed, "utf8")).toBe("sent\n");
		expect(existsSync(join(home, sentConversation("abc")))).toBe(false);
		// A shorter one is older: the host user's own copy stays, the sent one goes.
		writeFileSync(join(home, sentConversation("abc")), "old\n");
		run();
		expect(readFileSync(filed, "utf8")).toBe("sent\n");
		expect(existsSync(join(home, sentConversation("abc")))).toBe(false);
		// A longer one went on on my computer after a move there: it replaces it.
		writeFileSync(join(home, sentConversation("abc")), "sent\nmore here\n");
		run();
		expect(readFileSync(filed, "utf8")).toBe("sent\nmore here\n");
		expect(existsSync(join(home, sentConversation("abc")))).toBe(false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("this computer's copy of a conversation goes to the host when the host has none or a shorter one", () => {
	expect(sendsConversation("", 10)).toBe(true);
	expect(sendsConversation("5", 10)).toBe(true);
	expect(sendsConversation("10", 10)).toBe(false);
	expect(sendsConversation("20", 10)).toBe(false);
	// The host couldn't say: leave its copy alone.
	expect(sendsConversation("unknown", 10)).toBe(false);
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

test("the host note tells the agent how to hand me a command for my computer", () => {
	const note = hostNote({
		user: "ubuntu",
		name: "odin-remote",
		repoName: "odin",
		pane: "0d202ff3aa",
	});
	expect(note).toContain("first line starts with `!local `");
});

test("the host note tells a blocked agent to offer the move to my computer", () => {
	const note = hostNote({
		user: "ubuntu",
		name: "odin-remote",
		repoName: "odin",
		pane: "0d202ff3aa",
	});
	expect(note).toContain('starts with "Move this session to my computer"');
	expect(note).toContain("is not an action item");
});

test("the host note tells the agent to write in my voice and record corrections", () => {
	const note = hostNote({
		user: "ubuntu",
		name: "odin-remote",
		repoName: "odin",
		pane: "0d202ff3aa",
	});
	expect(note).toContain(VOICE_RULE);
});

test("the host note tells the agent how to add an Odin task", () => {
	const note = hostNote({
		user: "ubuntu",
		name: "odin-remote",
		repoName: "odin",
		pane: "0d202ff3aa",
	});
	expect(note).toContain(ODIN_TASK_RULE);
});

test("the host falls back to the API key only while the plan is limited", () => {
	const run = runScript(spec, "/d");
	expect(run).toContain(
		'then export ANTHROPIC_API_KEY="$ODIN_FALLBACK_API_KEY"; else unset ANTHROPIC_API_KEY; fi',
	);
	expect(run.indexOf("unset ODIN_FALLBACK_API_KEY")).toBeLessThan(
		run.indexOf("claude --dangerously-skip-permissions --settings"),
	);
	// Each resume picks the key or the plan again, and isn't exec'd, so the
	// session can move back to the plan later.
	expect(run).toContain(
		"then claude --dangerously-skip-permissions --settings",
	);
	expect(run).not.toContain("exec claude");
	const turnEnd = turnEndHook(run);
	expect(turnEnd).toContain("os.replace(");
	expect(turnEnd).not.toContain('plan-limit.json"), "w")');
	const hooks = JSON.parse(hostSettings).hooks;
	expect(hooks.Stop[0].hooks[0].command).toBe("python3 ~/.odin/turn-end.py");
	expect(hooks.StopFailure[0].hooks[0].command).toBe(
		"ODIN_TURN=failed python3 ~/.odin/turn-end.py",
	);
});

function turnEndHook(run: string): string {
	const hook = run.match(
		/printf %s '([^']+)' \| base64 -d > "\$HOME\/\.odin\/turn-end\.py\.\$\$"/,
	);
	return Buffer.from(hook?.[1] ?? "", "base64").toString();
}

// The hook walks /proc, which only the Linux host has.
test.skipIf(!existsSync("/proc/self/stat"))(
	"a session on the API key moves back to the plan once the limit has passed",
	() => {
		const hook = turnEndHook(runScript(spec, "/d"));
		const home = mkdtempSync(join(tmpdir(), "odin-back-to-plan-"));
		mkdirSync(join(home, ".claude"));
		mkdirSync(join(home, ".odin"));
		// The outer bash is the run script, the inner one stands in for Claude and,
		// like Claude, is still running when the hook stops it.
		const turnEnds = (until: number, env: Record<string, string>) => {
			writeFileSync(
				join(home, ".claude", "plan-limit.json"),
				JSON.stringify({ until }),
			);
			const out = execFileSync(
				"bash",
				[
					"-c",
					`export ODIN_RUN_PID=$$; bash -c 'echo "$IN" | python3 -c "$HOOK"; [ -e "$HOME/.odin/resume-$ODIN_RUN_PID" ] && exec sleep 10; true'; echo $$`,
				],
				{
					env: {
						PATH: process.env.PATH,
						HOME: home,
						HOOK: hook,
						IN: '{"session_id":"s1"}',
						ODIN_HAS_FALLBACK_KEY: "1",
						...env,
					},
				},
			)
				.toString()
				.trim();
			const file = join(home, ".odin", `resume-${out}`);
			try {
				return readFileSync(file, "utf8");
			} catch {
				return null;
			}
		};
		const now = Date.now() / 1000;
		expect(turnEnds(now + 3600, { ANTHROPIC_API_KEY: "k" })).toBeNull();
		expect(turnEnds(now - 60, {})).toBeNull();
		expect(turnEnds(now - 60, { ANTHROPIC_API_KEY: "k" })).toBe("s1");
	},
);

test("the host reports Working and Done to the card through Odin's notify hook", () => {
	const hooks = JSON.parse(hostSettings).hooks;
	expect(hooks.UserPromptSubmit[0].hooks[0].command).toContain(
		`$HOME/${HOST_NOTIFY_HOOK}`,
	);
	expect(hooks.Stop[1].hooks[0].command).toContain(`$HOME/${HOST_NOTIFY_HOOK}`);
});

test("a remote session's rules reach Claude through the host's hooks", () => {
	const pr = '{"hookSpecificOutput":{"additionalContext":"run /land-pr"}}';
	const turn = '{"hookSpecificOutput":{"additionalContext":"every rule"}}';
	// The run script writes each answer where its hook reads it.
	const run = runScript({ ...spec, pane: "abc", rules: { pr, turn } }, "/s");
	const written = (variable: string) =>
		Buffer.from(
			run.match(
				new RegExp(`printf %s '([^']+)' \\| base64 -d > "\\$${variable}"`),
			)?.[1] ?? "",
			"base64",
		).toString();
	expect(written("ODIN_RULES")).toBe(pr);
	expect(written("ODIN_RULES_TURN")).toBe(turn);
	const none = runScript({ ...spec, pane: "abc" }, "/s");
	expect(none).toContain('rm -f "$ODIN_RULES"');
	expect(none).toContain('rm -f "$ODIN_RULES_TURN"');

	const dir = mkdtempSync(join(tmpdir(), "rules-"));
	const prFile = join(dir, "pr.json");
	const turnFile = join(dir, "turn.json");
	writeFileSync(prFile, pr);
	writeFileSync(turnFile, turn);
	const { hooks } = JSON.parse(hostSettings);
	const fire = (command: string, input: string, env: Record<string, string>) =>
		spawnSync("sh", ["-c", command], {
			input,
			env: { PATH: "/usr/bin:/bin", ...env },
		}).stdout.toString();
	const onPush = hooks.PostToolUse.find(
		(h: { matcher?: string }) => h.matcher === "Bash",
	).hooks[0].command;
	const bash = (cmd: string) =>
		JSON.stringify({ tool_input: { command: cmd } });
	expect(fire(onPush, bash("gh pr create"), { ODIN_RULES: prFile })).toBe(pr);
	expect(fire(onPush, bash("ls"), { ODIN_RULES: prFile })).toBe("");
	expect(fire(onPush, bash("git push"), { ODIN_RULES: join(dir, "x") })).toBe(
		"",
	);
	const onPrompt = hooks.UserPromptSubmit[1].hooks[0].command;
	expect(fire(onPrompt, "{}", { ODIN_RULES_TURN: turnFile })).toBe(turn);
	expect(fire(onPrompt, "{}", { ODIN_RULES_TURN: join(dir, "x") })).toBe("");
	rmSync(dir, { recursive: true });
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

test("a reconnect keeps a reply the first try never delivered, and the host skips one Claude took", () => {
	const again = reconnectSpec(
		{ ...spec, pane: "abc", prompt: "go on", fresh: true },
		1_700_000_000_000,
	);
	expect(again).toMatchObject({
		claudeArgs: "--resume abc",
		prompt: "go on",
		fresh: false,
		since: 1_700_000_000_000,
	});
	const b64 = Buffer.from("go on").toString("base64");
	const taken = `python3 -c ${sh(PROMPT_TAKEN)} 'abc' '${b64}' '1700000000000' 2>/dev/null`;
	// The first try: the prompt goes in as it is, and only a Resume with
	// nothing to say asks whether the turn was cut off.
	const first = runScript(
		{ ...spec, pane: "abc", claudeArgs: "--resume abc", prompt: "go on" },
		"/d",
	);
	expect(first).toContain(`\np=("$(printf %s '${b64}' | base64 -d)")\n`);
	expect(first).toContain(
		`[ "\${#p[@]}" -eq 0 ] && python3 -c ${sh(CUT_OFF_TURN)} 'abc' 2>/dev/null && p=(Continue)`,
	);
	expect(first).toContain(`--resume abc "\${p[@]}"`);
	expect(first).not.toContain(PROMPT_TAKEN);
	// A reconnect: the prompt goes in unless the conversation took it since
	// the helper started.
	const run = runScript(again, "/d");
	expect(run).toContain(
		`\n${taken} || p=("$(printf %s '${b64}' | base64 -d)")\n`,
	);
	// Pasted into a live tmux session: once its Claude is up, behind the same check.
	const attach = attachScript(again, "/d");
	expect(attach).toContain(
		`[ "$(tmux display -p -t 'odin-abc' '#{pane_current_command}' 2>/dev/null)" = claude ] && break`,
	);
	expect(attach).toContain(
		`${taken} || { printf %s '${b64}' | base64 -d | tmux load-buffer`,
	);
	expect(attach).toContain(
		") >/dev/null 2>&1 & exec tmux attach -d -t 'odin-abc'",
	);
	expect(
		attachScript(
			{ ...spec, pane: "abc", claudeArgs: "--resume abc", prompt: "go on" },
			"/d",
		),
	).not.toContain(PROMPT_TAKEN);
});

test("a prompt is taken once the conversation holds it as a turn or queued, from the reconnect's start", () => {
	const home = mkdtempSync(join(tmpdir(), "odin-taken-"));
	const b64 = Buffer.from(" go on\n").toString("base64");
	const taken = (since: number, ...entries: object[]) => {
		mkdirSync(join(home, ".claude/projects/-home-x"), { recursive: true });
		writeFileSync(
			join(home, ".claude/projects/-home-x/s.jsonl"),
			`${entries.map((e) => JSON.stringify(e)).join("\n")}\nnot json\n`,
		);
		try {
			execFileSync("python3", ["-c", PROMPT_TAKEN, "s", b64, String(since)], {
				env: { HOME: home, PATH: process.env.PATH },
			});
			return true;
		} catch {
			return false;
		}
	};
	// 1_700_000_000_000 is 2023-11-14T22:13:20Z.
	const since = 1_700_000_000_000;
	const user = (content: unknown, timestamp = "2023-11-14T22:13:21.000Z") => ({
		type: "user",
		timestamp,
		message: { content },
	});
	try {
		expect(taken(since, user("go on"))).toBe(true);
		expect(
			taken(since, user([{ type: "image" }, { type: "text", text: "go on" }])),
		).toBe(true);
		expect(taken(since, user("go on now"))).toBe(false);
		expect(taken(since, user("go"))).toBe(false);
		// The same words a while before the helper started are an earlier turn.
		// A minute's slack covers the two clocks.
		expect(taken(since, user("go on", "2023-11-14T22:11:00.000Z"))).toBe(false);
		expect(taken(since, user("go on", "2023-11-14T22:12:30.000Z"))).toBe(true);
		expect(taken(since, { ...user("go on"), isMeta: true })).toBe(false);
		expect(taken(since, { type: "user", message: { content: "go on" } })).toBe(
			false,
		);
		expect(
			taken(since, {
				type: "queue-operation",
				operation: "enqueue",
				timestamp: "2023-11-14T22:13:21.000Z",
				content: "go on",
			}),
		).toBe(true);
		expect(
			taken(since, {
				type: "queue-operation",
				operation: "remove",
				timestamp: "2023-11-14T22:13:21.000Z",
				content: "go on",
			}),
		).toBe(false);
		rmSync(join(home, ".claude"), { recursive: true });
		expect(taken(since)).toBe(false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a laptop path with spaces is copied whole, and its copy has none", () => {
	const local = "/Users/dan/dev/photos/Odin/Dark Purple Viking (1).jpeg";
	const { prompt, files } = hostFiles(
		`this for the app icon\u0000${local}`,
		"ubuntu",
		(path) => path === local,
	);
	expect(files).toEqual([
		{ local, remote: ".odin/files/0-Dark-Purple-Viking-(1).jpeg" },
	]);
	const copy = "/home/ubuntu/.odin/files/0-Dark-Purple-Viking-(1).jpeg";
	expect(prompt).toBe(`this for the app icon\u0000${copy}`);
});

test("a shell-escaped laptop path is copied by its real name", () => {
	const { prompt, files } = hostFiles(
		"look at /Users/d/my\\ file.txt please",
		"ubuntu",
		(path) => path === "/Users/d/my file.txt",
	);
	expect(files[0]?.local).toBe("/Users/d/my file.txt");
	expect(prompt).toBe("look at /home/ubuntu/.odin/files/0-my-file.txt please");
});

test("a path in parentheses ends before the closing one", () => {
	const { prompt } = hostFiles(
		"the icon (/Users/d/a b.png) is new",
		"ubuntu",
		(path) => path === "/Users/d/a b.png",
	);
	expect(prompt).toBe("the icon (/home/ubuntu/.odin/files/0-a-b.png) is new");
});

test("a host's first Claude skips onboarding, folder trust and the bypass-permissions warning", () => {
	const home = mkdtempSync(`${tmpdir()}/odin-first-run-`);
	mkdirSync(`${home}/.claude`);
	writeFileSync(`${home}/.claude/settings.json`, '{"model": "opus"}');
	execFileSync("python3", ["-c", SKIP_FIRST_RUN, "/home/u/repos/api"], {
		env: { HOME: home, PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
	});
	const config = JSON.parse(readFileSync(`${home}/.claude.json`, "utf8"));
	expect(config.hasCompletedOnboarding).toBe(true);
	expect(config.projects["/home/u/repos/api"].hasTrustDialogAccepted).toBe(
		true,
	);
	const settings = JSON.parse(
		readFileSync(`${home}/.claude/settings.json`, "utf8"),
	);
	expect(settings).toEqual({
		model: "opus",
		skipDangerousModePermissionPrompt: true,
		permissions: { deny: SLACK_DENY_RULES, allow: SLACK_ALLOW_RULES },
	});
});

test("allow-send lifts only Odin's Slack deny rules on the host", () => {
	const home = mkdtempSync(`${tmpdir()}/odin-slack-allow-`);
	mkdirSync(`${home}/.claude`);
	writeFileSync(
		`${home}/.claude/settings.json`,
		JSON.stringify({
			permissions: { deny: ["Bash(rm *)", ...SLACK_DENY_RULES], allow: [] },
		}),
	);
	execFileSync(
		"python3",
		["-c", SKIP_FIRST_RUN, "/home/u/repos/api", "allow-send"],
		{ env: { HOME: home, PATH: "/usr/bin:/bin:/opt/homebrew/bin" } },
	);
	const { permissions } = JSON.parse(
		readFileSync(`${home}/.claude/settings.json`, "utf8"),
	);
	expect(permissions.deny).toEqual(["Bash(rm *)"]);
	expect(permissions.allow).toEqual(SLACK_ALLOW_RULES);
});

test("a host session can't send Slack as the user: the deny joins the host's own rules once", () => {
	const home = mkdtempSync(`${tmpdir()}/odin-slack-deny-`);
	mkdirSync(`${home}/.claude`);
	writeFileSync(
		`${home}/.claude/settings.json`,
		JSON.stringify({ permissions: { deny: ["Bash(rm *)"], allow: ["Bash"] } }),
	);
	const run = () =>
		execFileSync("python3", ["-c", SKIP_FIRST_RUN, "/home/u/repos/api"], {
			env: { HOME: home, PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
		});
	run();
	run();
	const { permissions } = JSON.parse(
		readFileSync(`${home}/.claude/settings.json`, "utf8"),
	);
	expect(permissions.deny).toEqual(["Bash(rm *)", ...SLACK_DENY_RULES]);
	expect(permissions.allow).toEqual(["Bash", ...SLACK_ALLOW_RULES]);
	expect(permissions.deny).toContain(
		"mcp__claude_ai_Slack__slack_send_message",
	);
	expect(permissions.deny).toContain(
		"mcp__claude_ai_Slack__slack_schedule_message",
	);
});

test("a Resume of a conversation stuck at the usage limit records the limit", () => {
	const home = mkdtempSync(join(tmpdir(), "odin-limit-hit-"));
	const dir = join(home, ".claude", "projects", "-repo");
	mkdirSync(dir, { recursive: true });
	const write = (last: object) =>
		writeFileSync(
			join(dir, "s1.jsonl"),
			[{ type: "user", message: { content: "go" } }, last]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);
	const run = () =>
		spawnSync("python3", ["-c", RECORD_LIMIT_HIT, "s1"], {
			env: { HOME: home },
		}).status;
	write({ type: "assistant", message: { content: [{ text: "done" }] } });
	expect(run()).toBe(1);
	write({
		type: "assistant",
		isApiErrorMessage: true,
		error: "rate_limit",
		message: { content: [{ text: "You've hit your limit" }] },
	});
	expect(run()).toBe(0);
	const until = JSON.parse(
		readFileSync(join(home, ".claude", "plan-limit.json"), "utf8"),
	).until;
	expect(until).toBeGreaterThan(Date.now() / 1000 + 4 * 3600);
});

test("the host's prune pass runs the script once per repo with worktrees, at most every 10 min", () => {
	const home = mkdtempSync(join(tmpdir(), "odin-prune-home-"));
	const repo = (dir: string, worktrees: boolean) => {
		mkdirSync(join(home, dir, ".git", worktrees ? "worktrees" : "objects"), {
			recursive: true,
		});
		return realpathSync(join(home, dir));
	};
	const a = repo("repos/a", true);
	repo("repos/b", false);
	const c = repo("clones/c", true);
	const bash = (script: string) =>
		execFileSync("bash", ["-c", `HOME=${home}\n${script}`]);
	mkdirSync(join(home, ".odin"));
	bash(pruneInstallScript('echo "$1" >> "$HOME/ran"'));
	expect(pruneInstallScript(null)).toBe("");
	const ran = () => readFileSync(join(home, "ran"), "utf8").trim().split("\n");

	bash(prunePass('"$HOME"/clones'));
	expect(ran().sort()).toEqual([a, c].sort());
	// Within 10 min of a pass, another one does nothing.
	bash(prunePass('"$HOME"/clones'));
	expect(ran()).toHaveLength(2);
	// The clone folder is ~/repos itself: each repo still goes once.
	rmSync(join(home, ".odin", "pruned-at"));
	bash(prunePass('"$HOME"/repos'));
	expect(ran().slice(2)).toEqual([a]);
});

test("a host session gets the host note back after a compaction, a resume or /clear", () => {
	const run = runScript(
		{ ...spec, pane: "abc", startNote: "\nhost rules" },
		"/s",
	);
	const b64 = run.match(
		/printf %s '([^']+)' \| base64 -d > "\$ODIN_RULES_START"/,
	)?.[1];
	const file = join(mkdtempSync(join(tmpdir(), "start-")), "start.json");
	writeFileSync(file, Buffer.from(b64 ?? "", "base64"));
	expect(JSON.parse(readFileSync(file, "utf8")).hookSpecificOutput).toEqual({
		hookEventName: "SessionStart",
		additionalContext: "host rules",
	});
	const hook = JSON.parse(hostSettings).hooks.SessionStart[0].hooks[0].command;
	const fire = (source: string) =>
		execFileSync("bash", ["-c", hook], {
			input: JSON.stringify({ session_id: "abc", source }),
			env: { PATH: process.env.PATH, ODIN_RULES_START: file },
		}).toString();
	// The launch prompt already carries it.
	expect(fire("startup")).toBe("");
	for (const source of ["compact", "resume", "clear"])
		expect(JSON.parse(fire(source)).hookSpecificOutput.additionalContext).toBe(
			"host rules",
		);
	expect(runScript({ ...spec, pane: "abc" }, "/s")).toContain(
		'rm -f "$ODIN_RULES_START"',
	);
});

/** A bin folder whose node says `version` and whose curl logs its call and writes `body`. */
function fakeNodeHost(version: string, body: string) {
	const dir = mkdtempSync(join(tmpdir(), "odin-node-"));
	mkdirSync(join(dir, "bin"));
	writeFileSync(
		join(dir, "bin", "node"),
		`#!/bin/sh\n[ "$1" = -v ] && echo v${version}\n[ "$1" = -e ] && [ ${version.split(".")[0]} -lt 22 ] && exit 1\nexit 0\n`,
		{ mode: 0o755 },
	);
	writeFileSync(
		join(dir, "bin", "curl"),
		`#!/bin/sh\necho "$*" >> "${dir}/curl.log"\nwhile [ "$1" != -o ]; do shift; done\nprintf %s ${sh(body)} > "$2"\n`,
		{ mode: 0o755 },
	);
	const run = (script: string) =>
		spawnSync("bash", ["-c", script], {
			env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin` },
			encoding: "utf8",
		});
	const curled = () =>
		existsSync(join(dir, "curl.log"))
			? readFileSync(join(dir, "curl.log"), "utf8")
			: "";
	return { dir, run, curled };
}

test("host setup fetches Node 22 for the host's CPU when its node is older, and keeps nothing that fails the checksum", () => {
	const host = fakeNodeHost("20.18.0", "not node");
	const target = join(host.dir, "odin-node");
	host.run(nodeInstallScript(target));
	const arch = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim();
	expect(host.curled()).toContain(
		`https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-${/aarch64|arm64/.test(arch) ? "arm64" : "x64"}.tar.gz`,
	);
	expect(existsSync(target)).toBe(false);
});

test("a host whose own node is 22 or newer gets no download, and a session's PATH keeps its node", () => {
	const host = fakeNodeHost("24.1.0", "");
	host.run(nodeInstallScript(join(host.dir, "odin-node")));
	expect(host.curled()).toBe("");
	expect(NODE_ON_PATH).toContain('export PATH="/opt/odin-node/bin:$PATH"');
});

test("the host note says the CPU may be ARM and what setup installs", () => {
	const note = hostNote({ user: "me", name: "box", repoName: null, pane: "p" });
	expect(note).toContain("uname -m");
	expect(note).toContain("Node 22");
});
