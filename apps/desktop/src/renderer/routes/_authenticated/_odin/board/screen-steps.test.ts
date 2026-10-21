import { describe, expect, test } from "bun:test";
import { screenSteps, unrecordedSteps } from "./screen-steps";

const FOOTER = [
	"",
	"────────────────────────────────────────────────────────────",
	"❯ ",
	"────────────────────────────────────────────────────────────",
	"  ⏵⏵ auto mode on (shift+tab to cycle)",
];

const screen = (...lines: string[]) => [...lines, ...FOOTER].join("\n");

describe("screenSteps", () => {
	test("a line and the command running under it, after your prompt", () => {
		expect(
			screenSteps(
				screen(
					"● Done. The fix is in PR #12.",
					"",
					"> moving sessions to IDLE should only be done for local sessions",
					"",
					"● I'll exclude remote sessions from the idle sweep since they use no local memory and keep running in tmux, while keeping the start-time",
					"  fix for local sessions.",
					"",
					"  Bash(python3 -I - <<'EOF'",
					'      p = "apps/desktop/src/renderer/routes/_authenticated/_odin/board/page.tsx"…)',
					"  ⎿  Running…",
					"",
					"✻ Thinking… (2m 29s · ↓ 7.7k tokens)",
					"  ⎿  Tip: Use /btw to ask a quick side question",
				),
			),
		).toEqual([
			{
				kind: "text",
				text: "I'll exclude remote sessions from the idle sweep since they use no local memory and keep running in tmux, while keeping the start-time fix for local sessions.",
			},
			{
				kind: "tool",
				text: `Bash(python3 -I - <<'EOF' p = "apps/desktop/src/renderer/routes/_authenticated/_odin/board/page.tsx"…)`,
			},
		]);
	});

	test("a described command with its timer, a tagged line, hook notes, no prompt on screen", () => {
		expect(
			screenSteps(
				screen(
					"  ⎿  PreToolUse:Bash hook error",
					"  ⎿  Failed with non-blocking status code: /bin/sh: 1: /home/ubuntu/dev/imagen/i",
					"     nternal-claude/scripts/hooks/dedup-triage-comment.py: not found",
					"",
					"● I'll show Claude's live narration and the running command under the Working…",
					"  row, reading from the terminal screen until the transcript catches up.",
					"  Gathering what's needed: exact screen rows, the readScreen contract, existing",
					"  screen-parsing helpers, and a working bun install. · summary",
					"",
					"● Checking the worktree's install state and the remote-host build notes · 6s",
					"  ⎿  $ ls node_modules 2>/dev/null | wc -l; ls ~/.bun/bin 2>/dev/null; cat",
					'     scripts/session-worktree.sh | grep -n "bun install" ; cat /home/ubuntu/.cla',
					"     ude/projects/-home-ubuntu-repos/memory/project-odin-repo-on-remote-host.md",
					"",
					"✶ Calculating… (52m 58s · ↓ 111.0k tokens)",
					"  ⎿  Tip: Use /clear to start fresh when switching topics and free up context",
				),
			),
		).toEqual([
			{
				kind: "text",
				text: "I'll show Claude's live narration and the running command under the Working… row, reading from the terminal screen until the transcript catches up. Gathering what's needed: exact screen rows, the readScreen contract, existing screen-parsing helpers, and a working bun install.",
			},
			{
				kind: "tool",
				text: "Checking the worktree's install state and the remote-host build notes",
			},
		]);
	});

	test("finished commands, the previous turn and the spinner's own rows are left out", () => {
		expect(
			screenSteps(
				screen(
					"● All done.",
					"",
					"✻ Cooked for 1m 30s",
					"",
					"> next one",
					"",
					"● Read(page.tsx)",
					"  ⎿  Read 120 lines",
					"",
					"● Searched for odinStatusAt",
					"  ⎿  Found 3 files (ctrl+o to expand)",
					"",
					"● Looking at the sweep now.",
					"",
					"· Calculating… (running PreToolUse hooks… 3/4 · 54m 19s · ↓ 116.9k tokens)",
				),
			),
		).toEqual([{ kind: "text", text: "Looking at the sweep now." }]);
	});

	test("a wrapped prompt is yours, not a step", () => {
		expect(
			screenSteps(
				screen(
					"> Task: why chat view doesn't show claude's text as steps? Standing rules - follow",
					"  each one whenever its situation comes up during this session, without being",
					"  asked: when you open a pull request, run /get-pr-approved",
					"",
					"● Looking at the chat view's transcript reader first.",
					"",
					"✻ Thinking… (12s · ↓ 300 tokens)",
				),
			),
		).toEqual([
			{
				kind: "text",
				text: "Looking at the chat view's transcript reader first.",
			},
		]);
	});

	test("nothing drawn yet, or a dialog instead of a spinner", () => {
		expect(screenSteps(screen("> go", ""))).toEqual([]);
		expect(screenSteps(screen("> go", "  on, two rows", ""))).toEqual([]);
		expect(
			screenSteps(
				screen(
					"> go",
					"",
					"● On it.",
					"",
					"  Bash(rm -rf build)",
					"  ⎿  Running…",
					"",
					"Do you want to proceed?",
					"❯ 1. Yes",
					"  2. No",
					"",
					"Enter to select",
				),
			),
		).toEqual([
			{ kind: "text", text: "On it." },
			{ kind: "tool", text: "Bash(rm -rf build)" },
		]);
	});
});

describe("unrecordedSteps", () => {
	const line = {
		kind: "text" as const,
		text: "I'll exclude remote sessions from the idle sweep since they use no local memory and keep running in tmux.",
	};
	const command = { kind: "tool" as const, text: "Bash(python3 -I -)" };

	test("everything, while the transcript has none of it", () => {
		expect(unrecordedSteps([line, command], [{ kind: "user" }])).toEqual([
			line,
			command,
		]);
	});

	test("a line the transcript holds, in Markdown or scrolled to its tail", () => {
		const reply = {
			kind: "text",
			text: "I'll **exclude** remote sessions from the idle sweep since they use no local memory and keep running in `tmux`.",
		};
		expect(unrecordedSteps([line], [reply])).toEqual([]);
		const tail = {
			kind: "text" as const,
			text: "no local memory and keep running in tmux.",
		};
		expect(unrecordedSteps([tail], [reply])).toEqual([]);
		const linked = {
			kind: "text" as const,
			text: "Opened PR #12 (https://github.com/danlinenberg/odin/pull/12) for the sweep.",
		};
		expect(
			unrecordedSteps(
				[linked],
				[
					{
						kind: "text",
						text: "Opened [PR #12](https://github.com/danlinenberg/odin/pull/12) for the sweep.",
					},
				],
			),
		).toEqual([]);
		expect(
			unrecordedSteps([line], [{ kind: "text", text: "Something else." }]),
		).toEqual([line]);
	});

	test("the command, once the transcript holds a command without its result", () => {
		expect(
			unrecordedSteps([command], [{ kind: "tool", result: "ok" }]),
		).toEqual([command]);
		expect(unrecordedSteps([command], [{ kind: "tool" }])).toEqual([]);
	});
});
