import { describe, expect, it } from "bun:test";
import { menuKeys, parseScreenAside, parseScreenMenu } from "./screen-menu";

const BYPASS = `
 ──────────────────────────────────────────
  WARNING: Claude Code running in Bypass Permissions mode

  By proceeding, you accept all responsibility.

  https://code.claude.com/docs/en/security

  ❯ No, exit
    Yes, I accept

  Enter to confirm · Esc to cancel
`;

const PERMISSION = `
╭──────────────────────────────────────────╮
│ Bash command                             │
│                                          │
│   rm -rf build                           │
│                                          │
│ Do you want to proceed?                  │
│ ❯ 1. Yes                                 │
│   2. Yes, and don't ask again for rm     │
│      commands in this project            │
│   3. No, and tell Claude what to do      │
╰──────────────────────────────────────────╯
`;

const INPUT = `
❯ 1. fix the build
  2. then open a PR

⏺ Done.

──────────────────────────────────────────
❯
──────────────────────────────────────────
  ? for shortcuts
`;

describe("parseScreenMenu", () => {
	it("reads an unnumbered menu with a footer", () => {
		const menu = parseScreenMenu(BYPASS);
		expect(menu?.options).toEqual(["No, exit", "Yes, I accept"]);
		expect(menu?.selected).toBe(0);
		expect(menu?.title).toContain("Bypass Permissions mode");
		expect(menu?.title).not.toContain("────");
	});

	it("reads a boxed numbered menu, skipping wrapped detail", () => {
		const menu = parseScreenMenu(PERMISSION);
		expect(menu?.options).toEqual([
			"Yes",
			"Yes, and don't ask again for rm",
			"No, and tell Claude what to do",
		]);
		expect(menu?.title).toContain("Do you want to proceed?");
	});

	it("ignores the input box and history above it", () => {
		expect(parseScreenMenu(INPUT)).toBeNull();
	});

	it("arrows from the cursor to the pick, then Enter", () => {
		const menu = parseScreenMenu(BYPASS);
		if (!menu) throw new Error("no menu");
		expect(menuKeys(menu, 1)).toEqual(["\x1b[B", "\r"]);
		expect(menuKeys(menu, 0)).toEqual(["\r"]);
	});
});

const ASIDE = `
❯ /btw name three primary colors, one per line

  /btw name three primary colors, one per line

    Red: the color of fire.
      Yellow: the sun.
    Blue: the sky.

  ↑/↓ to scroll · c to copy · f to fork · Esc to close
`;

// Read off a remote session's tmux pane: the dialog's top edge is ▔, and the
// conversation above it is no part of the question.
const LIMIT = `
  ⎿  You've hit your individual spend limit · your weekly limit resets Oct 21,
     4am (UTC)
✻ Baked for 0s · done 8:36 PM
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   What do you want to do?
   ❯ 1. Stop and wait for limit to reset
     2. Wait here, then continue automatically at Oct 21, 4am
   Enter to confirm · Esc to cancel
[odin-a1d90:claude*                              "✳ Claude Code" 23:39 18-Oct-26
`;

describe("usage limit menu", () => {
	it("stops the question at the dialog's edge", () => {
		expect(parseScreenMenu(LIMIT)).toEqual({
			title: "What do you want to do?",
			options: [
				"Stop and wait for limit to reset",
				"Wait here, then continue automatically at Oct 21, 4am",
			],
			selected: 0,
		});
	});
});

describe("parseScreenAside", () => {
	it("reads a /btw answer off the overlay", () => {
		expect(parseScreenAside(ASIDE)).toEqual({
			question: "/btw name three primary colors, one per line",
			answer: "Red: the color of fire.\n  Yellow: the sun.\nBlue: the sky.",
		});
		expect(parseScreenMenu(ASIDE)).toBeNull();
	});

	it("shows the question while Claude is answering", () => {
		expect(
			parseScreenAside(
				"❯ /btw what is 2+2\n\n  /btw what is 2+2    · Answering…  Esc to close\n",
			),
		).toEqual({ question: "/btw what is 2+2", answer: null });
	});

	it("ignores a screen with no overlay", () => {
		expect(parseScreenAside("❯ /btw what is 2+2\n")).toBeNull();
		expect(parseScreenAside(BYPASS)).toBeNull();
	});
});
