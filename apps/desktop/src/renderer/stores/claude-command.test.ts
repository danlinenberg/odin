import { expect, test } from "bun:test";
import {
	claudeLaunch,
	modelFlag,
	pickClaudeCommand,
	remoteControlEnv,
	remoteControlFlag,
	remoteControlOn,
	useClaudeCommand,
} from "./claude-command";

test("pickClaudeCommand", () => {
	expect(pickClaudeCommand([], "")).toBe("claude");
	expect(pickClaudeCommand(["claude-me", "claude-work"], "")).toBe("claude-me");
	expect(pickClaudeCommand(["claude-me", "claude-work"], "claude-work")).toBe(
		"claude-work",
	);
	// A removed pick falls back to the first one left.
	expect(pickClaudeCommand(["claude-me"], "claude-work")).toBe("claude-me");
});

test("modelFlag", () => {
	expect(modelFlag("")).toBe("");
	expect(modelFlag("opus")).toBe(" --model opus");
	expect(modelFlag("opus; rm -rf ~")).toBe("");
});

test("remoteControlFlag: always named [Odin] <task>", () => {
	expect(remoteControlFlag("Fix it", false)).toBe("");
	expect(remoteControlFlag("Fix  dan's\nbug", true)).toBe(
		` --remote-control '[Odin] Fix dan'\\''s bug'`,
	);
	expect(remoteControlFlag("  ", true)).toBe(" --remote-control '[Odin]'");
});

test("remoteControlEnv", () => {
	expect(remoteControlEnv(false)).toBe("");
	expect(remoteControlEnv(true)).toBe(
		"unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && ",
	);
});

test("claudeLaunch: a resume gets Remote Control like a new session", () => {
	useClaudeCommand.setState({ commands: [], model: "", remoteControl: "all" });
	expect(claudeLaunch("Fix it", "--resume abc")).toBe(
		"unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && claude --dangerously-skip-permissions --remote-control '[Odin] Fix it' --resume abc",
	);
	useClaudeCommand.setState({ remoteControl: "off" });
	expect(claudeLaunch("Fix it", "--resume abc")).toBe(
		"claude --dangerously-skip-permissions --resume abc",
	);
});

test("remoteControlOn: selected sessions only", () => {
	useClaudeCommand.setState({ remoteControl: "selected", remotePanes: [] });
	expect(remoteControlOn("p1")).toBe(false);
	useClaudeCommand.getState().toggleRemotePane("p1");
	expect(remoteControlOn("p1")).toBe(true);
	expect(remoteControlOn("p2")).toBe(false);
	expect(remoteControlOn()).toBe(false);
	expect(claudeLaunch("Fix it", "--resume abc", "p2")).toBe(
		"unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && claude --dangerously-skip-permissions --resume abc",
	);
	useClaudeCommand.getState().toggleRemotePane("p1");
	expect(remoteControlOn("p1")).toBe(false);
	useClaudeCommand.setState({ remoteControl: "off" });
});

test("recent repos: newest first, no repeats, at most five", () => {
	const { addRecentRepo } = useClaudeCommand.getState();
	useClaudeCommand.setState({ recentRepos: [] });
	for (const repo of ["/a", "/b", "/c", "/d", "/e", "/f", "/b"])
		addRecentRepo(repo);
	expect(useClaudeCommand.getState().recentRepos).toEqual([
		"/b",
		"/f",
		"/e",
		"/d",
		"/c",
	]);
});

test("claudeLaunch: a shell wrapper hands the flags through to claude", () => {
	// `zsh -ic 'claude'` - what `-c` gets after the quote is zsh's own
	// `$0 $1 ...`, so the flags and the prompt have to ride on "$@".
	useClaudeCommand.setState({
		commands: ["zsh -ic 'claude'"],
		active: "",
		model: "",
		remoteControl: "off",
	});
	expect(
		claudeLaunch("Fix it", `--session-id abc "$(cat '/w/.odin/task-fix.md')"`),
	).toBe(
		`zsh -ic 'claude "$@"' zsh --dangerously-skip-permissions --session-id abc "$(cat '/w/.odin/task-fix.md')"`,
	);
	// Remote Control's unset runs inside the wrapper: its rc file would put
	// the token right back.
	useClaudeCommand.setState({ remoteControl: "all" });
	expect(claudeLaunch("Fix it", "--resume abc")).toBe(
		`zsh -ic 'unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && claude "$@"' zsh --dangerously-skip-permissions --remote-control '[Odin] Fix it' --resume abc`,
	);
	// Double quotes: the outer shell reads them, so "$@" is escaped through.
	useClaudeCommand.setState({
		commands: ['bash -lc "claude --enable-auto-mode"'],
		remoteControl: "off",
	});
	expect(claudeLaunch("Fix it", "--resume abc")).toBe(
		`bash -lc "claude --enable-auto-mode \\"\\$@\\"" bash --dangerously-skip-permissions --resume abc`,
	);
	// No quotes, and a path to the shell.
	useClaudeCommand.setState({ commands: ["/bin/zsh -i -c claude"] });
	expect(claudeLaunch("Fix it", "--resume abc")).toBe(
		`/bin/zsh -i -c 'claude "$@"' /bin/zsh --dangerously-skip-permissions --resume abc`,
	);
	// A plain command, an alias, a path: as before.
	for (const command of [
		"claude",
		"claude-work",
		"~/bin/claude --enable-auto-mode",
	]) {
		useClaudeCommand.setState({ commands: [command] });
		expect(claudeLaunch("Fix it", "--resume abc")).toBe(
			`${command} --dangerously-skip-permissions --resume abc`,
		);
	}
	useClaudeCommand.setState({ commands: [] });
});

test.skipIf(!Bun.which("bash"))(
	"claudeLaunch: through a real shell wrapper, claude gets the session id and the prompt",
	async () => {
		// The wrapper's own rc file is what defines `claude` - the reason to
		// start through one. It writes its argv down; the prompt comes from a
		// file through "$(cat ...)", as useLaunchTaskSession passes it.
		const home = `${process.env.TMPDIR ?? "/tmp"}/odin-claude-${crypto.randomUUID()}`;
		const argv = `${home}/argv`;
		await Bun.write(
			`${home}/.bash_profile`,
			`claude() { printf '%s\\n' "$@" > '${argv}'; }\n`,
		);
		const prompt = `${home}/task.md`;
		const text = `Fix it: the "first" message, it's $HOME\nline two`;
		await Bun.write(prompt, text);
		useClaudeCommand.setState({
			commands: ['bash -lc "claude"'],
			active: "",
			model: "",
			remoteControl: "off",
		});
		const command = claudeLaunch(
			"Fix it",
			`--session-id abc "$(cat '${prompt}')"`,
		);
		useClaudeCommand.setState({ commands: [] });
		const run = Bun.spawnSync(["sh", "-c", command], {
			env: { PATH: process.env.PATH, HOME: home },
			stdin: "ignore",
			stderr: "pipe",
		});
		expect(run.exitCode).toBe(0);
		expect(await Bun.file(argv).text()).toBe(
			`--dangerously-skip-permissions\n--session-id\nabc\n${text}\n`,
		);
	},
);
