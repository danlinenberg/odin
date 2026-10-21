import { describe, expect, test } from "bun:test";
import {
	screenSteps,
	settleSteps,
	UNSETTLED,
	unrecordedSteps,
} from "./screen-steps";

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

	test("a described command with its timer, the TUI's digest, hook notes, no prompt on screen", () => {
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
				text: "I'll show Claude's live narration and the running command under the Working… row, reading from the terminal screen until the transcript catches up.",
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

	test("the previous turn ends at its closing line, or at your message left in the box", () => {
		const previous = [
			"  FROM big_brother_users",
			"  WHERE last_name LIKE 'Kaler%' OR first_name LIKE 'Alan%' OR email LIKE",
			"  'alan%';",
			"",
			"  ACTION ITEMS",
			"  1. Run the SELECT above and give me Alan's id, role and is_active (you only)",
			"",
			"✻ Cooked for 2m 3s · done 10:11 AM",
			"",
		];
		const turn = [
			"● Looking at the remote host's config.",
			"",
			"✻ Thinking… (22s · ↓ 1.2k tokens)",
		];
		const line = {
			kind: "text" as const,
			text: "Looking at the remote host's config.",
		};
		expect(
			screenSteps(
				screen(
					...previous,
					"❯ is it because we run odin-remote on dev?",
					"",
					...turn,
				),
			),
		).toEqual([line]);
		expect(screenSteps(screen(...previous, ...turn))).toEqual([line]);
		expect(screenSteps(screen(...previous))).toEqual([]);
	});

	test("a torn frame - the last one showing through the new one - is no read at all", () => {
		// Each row's first two columns, and the rows that should be blank, still
		// hold the frame before this one. Joined as prose it read "FROM
		// big_brother_users FoWHERE … SE ACTION ITEMS SE1. RundthemSELECTiabove …
		// AC ✻ Cooked for 2m 3s · done 10:11 AM AC ❯ is it because …".
		expect(
			screenSteps(
				screen(
					"  FROM big_brother_users",
					"FoWHERE last_name LIKE 'Kaler%' OR first_name LIKE 'Alan%' OR email LIKE",
					"Ra'alan%';",
					"SE",
					"  ACTION ITEMS",
					"SE1. RundthemSELECTiabove and give me Alan's idisrole and is_active (you ongy)",
					"Fo2. Merge PR #996 now, or tell me to wait for Alan's id [now | wait]",
					"SE3. Post the draft reply in Alan's thread (you only)",
					"AC4. Decide whether odin-remote gets a scoped read-only DB secret [yes, open a",
					"SE terraform PR | no, DB tasks run on the Mac]",
					"AC",
					"✻ Cooked for 2m 3s · done 10:11 AM",
					"AC",
					"❯ is it because we run odin-remote on dev?",
					"1.",
					"",
					"✻ Thinking… (22s · ↓ 1.2k tokens)",
				),
			),
		).toBeUndefined();
		expect(
			screenSteps(
				screen(
					"> go",
					"",
					"● Looking at the sweep now, then",
					"SEthe idle check.",
					"",
					"✻ Thinking… (2s · ↓ 300 tokens)",
				),
			),
		).toBeUndefined();
		// A row of digits and marks alone is a fragment, not a line.
		expect(
			screenSteps(
				screen("> go", "", "  1.", "", "✻ Thinking… (2s · ↓ 300 tokens)"),
			),
		).toEqual([]);
	});
});

describe("screenSteps keeps Claude's lines", () => {
	test("a code block and a list keep their line breaks; a wrapped line is one line", () => {
		expect(
			screenSteps(
				screen(
					"> find alan",
					"",
					"● Here is the query, then what I need from you:",
					"",
					"  SELECT id, role, is_active",
					"  FROM big_brother_users",
					"  WHERE last_name LIKE 'Kaler%' OR first_name LIKE 'Alan%' OR email LIKE",
					"  'alan%';",
					"",
					"  ACTION ITEMS",
					"  1. Run the SELECT above and give me Alan's id, role and is_active (you",
					"     only)",
					"  2. Merge PR #996 now, or tell me to wait for Alan's id [now | wait]",
					"  - A dash item too",
					"",
					"✻ Thinking… (22s · ↓ 1.2k tokens)",
				),
			),
		).toEqual([
			{ kind: "text", text: "Here is the query, then what I need from you:" },
			{
				kind: "text",
				text: "SELECT id, role, is_active\nFROM big_brother_users\nWHERE last_name LIKE 'Kaler%' OR first_name LIKE 'Alan%' OR email LIKE 'alan%';",
			},
			{
				kind: "text",
				text: "ACTION ITEMS\n1. Run the SELECT above and give me Alan's id, role and is_active (you only)\n2. Merge PR #996 now, or tell me to wait for Alan's id [now | wait]\n- A dash item too",
			},
		]);
	});

	test("the digest the TUI tags summary is not Claude's words", () => {
		expect(
			screenSteps(
				screen(
					"> go",
					"",
					"● I confirmed this host exits through the dev NAT gateway, and that address",
					"  is already whitelisted on prod Aurora. · summary",
					"",
					"✻ Thinking… (22s · ↓ 1.2k tokens)",
				),
			),
		).toEqual([]);
	});
});

describe("settleSteps", () => {
	const a = { kind: "text" as const, text: "Looking at the sweep" };
	const b = { kind: "text" as const, text: "Looking at the sweep now." };
	const run = { kind: "tool" as const, text: "Bash(ls)" };

	test("a read shows once the next poll agrees with it, timed from then", () => {
		const once = settleSteps(UNSETTLED, [a], 1);
		expect(once.shown).toEqual([]);
		expect(settleSteps(once, [b], 2).shown).toEqual([]);
		expect(settleSteps(settleSteps(once, [b], 2), [b], 3).shown).toEqual([
			{ ...b, at: 3 },
		]);
	});

	test("a line still streaming grows in place and keeps its time; the command joins it", () => {
		const shown = settleSteps(settleSteps(UNSETTLED, [a], 1), [a], 2);
		expect(shown.shown).toEqual([{ ...a, at: 2 }]);
		expect(settleSteps(shown, [b], 3).shown).toEqual([{ ...b, at: 2 }]);
		expect(settleSteps(shown, [b, run], 3).shown).toEqual([
			{ ...b, at: 2 },
			{ ...run, at: 3 },
		]);
		expect(settleSteps(shown, [run], 3).shown).toEqual([{ ...a, at: 2 }]);
	});

	test("a torn read changes nothing; two empty reads clear it", () => {
		const shown = settleSteps(settleSteps(UNSETTLED, [a], 1), [a], 2);
		expect(settleSteps(shown, undefined, 3)).toBe(shown);
		expect(settleSteps(shown, [], 3).shown).toEqual([{ ...a, at: 2 }]);
		expect(settleSteps(settleSteps(shown, [], 3), [], 4).shown).toEqual([]);
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
