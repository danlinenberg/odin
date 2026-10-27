import { describe, expect, it } from "bun:test";
import {
	menuKeys,
	parseScreenAside,
	parseScreenAuth,
	parseScreenDialog,
	parseScreenMenu,
} from "./screen-menu";

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

const MCP = `
❯ /mcp

────────────────────────────────────────────────────────────
  Manage MCP servers
  6 servers

    User MCPs (/Users/dan/.claude.json)
    ✔ canva                  46 tools
    ✔ gmail                  21 tools

    claude.ai
  ❯ △ claude.ai Hex          needs authentication
    ✔ claude.ai Sentry       12 tools

    Built-in MCPs (always available)
    ✔ plugin:Notion:notion   66 tools
    ✔ plugin:slack:slack     27 tools

  https://code.claude.com/docs/en/mcp for help
 ↑/↓ to navigate · Enter to confirm · Esc to cancel
`;

const MCP_SERVER = `
 ▝▝   ▝▝   /…/scratchpad
  ⎿  SessionStart:startup says: AWS unreachable
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ You're close to your usage credit limit ▔
   Claude.ai Imagen Real Estate MCP Server

   Status:           ⚠ needs authentication
   URL:              https://imagen-public-mcp.imagen-ai-op.com
   Config location:  claude.ai

   ❯ 1. Authenticate
     2. Disable

   ↑/↓ to navigate · Enter to select · Esc to back
`;

const MCP_AUTH = `
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Authenticating with claude.ai Imagen Real Estate…

   ✶  A browser window will open for authentication

   If your browser doesn't open automatically, copy this URL manually (c to copy)
   https://claude.ai/api/organizations/bb25/mcp/start-auth/mcpsrv_01PA?product_surfac
   e=cli

      Press Enter after authenticating in your browser.

      Esc to back
`;

describe("/mcp", () => {
	it("offers Esc on the server list", () => {
		expect(parseScreenMenu(MCP)?.escape).toBe("Cancel");
	});

	it("reads a server's actions, its title stopping at the dialog edge", () => {
		const menu = parseScreenMenu(MCP_SERVER);
		expect(menu?.options).toEqual(["Authenticate", "Disable"]);
		expect(menu?.escape).toBe("Back");
		expect(menu?.title.split("\n")[0]).toBe(
			"Claude.ai Imagen Real Estate MCP Server",
		);
	});

	it("reads the sign-in step, joining the wrapped URL", () => {
		expect(parseScreenAuth(MCP_AUTH)).toEqual({
			title: "Authenticating with claude.ai Imagen Real Estate",
			url: "https://claude.ai/api/organizations/bb25/mcp/start-auth/mcpsrv_01PA?product_surface=cli",
		});
		expect(parseScreenAuth(MCP)).toBeNull();
	});
});

describe("parseScreenMenu", () => {
	it("reads /mcp's grouped list, skipping the group headers", () => {
		const menu = parseScreenMenu(MCP);
		expect(menu?.options).toEqual([
			"✔ canva                  46 tools",
			"✔ gmail                  21 tools",
			"△ claude.ai Hex          needs authentication",
			"✔ claude.ai Sentry       12 tools",
			"✔ plugin:Notion:notion   66 tools",
			"✔ plugin:slack:slack     27 tools",
		]);
		expect(menu?.selected).toBe(2);
		expect(menu?.title).toBe("Manage MCP servers\n6 servers");
	});

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
			escape: "Cancel",
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

describe("parseScreenDialog", () => {
	it("returns the text of a dialog the menu reader can't parse", () => {
		const odd = `
──────────────────────────────────────────
  Pick a theme

  ❯ Dark mode
  Enter to confirm
──────────────────────────────────────────
`;
		expect(parseScreenMenu(odd)).toBeNull();
		expect(parseScreenDialog(odd)).toBe(
			"Pick a theme\n\n❯ Dark mode\nEnter to confirm",
		);
	});

	it("ignores the input box", () => {
		expect(parseScreenDialog(INPUT)).toBeNull();
	});
});
