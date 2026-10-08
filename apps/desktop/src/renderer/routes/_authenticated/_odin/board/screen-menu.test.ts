import { describe, expect, it } from "bun:test";
import { menuKeys, parseScreenMenu } from "./screen-menu";

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
