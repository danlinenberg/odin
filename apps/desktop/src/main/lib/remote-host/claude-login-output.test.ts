import { describe, expect, test } from "bun:test";
import { asksForCode, claudeOnPath, signInLink } from "./claude-login-output";

const LINK =
	"https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=abc123&code_challenge_method=S256&state=xyz789";

/** What `claude auth login --claudeai` prints on Windows, as Odin's pty reads it. */
const WINDOWS_OUTPUT = `Opening browser to sign in…\r\nIf the browser didn't open, visit: ${LINK}\r\nPaste code here if prompted > `;

describe("claude auth login's terminal output", () => {
	test("finds the sign-in link in what Claude prints on Windows", () => {
		expect(signInLink(WINDOWS_OUTPUT)).toBe(LINK);
	});

	test("finds the link through color and cursor escapes", () => {
		const styled = `\x1b[?25l\x1b[2mIf the browser didn't open, visit:\x1b[22m \x1b[4m${LINK}\x1b[24m\x1b[1BPaste code here if prompted >`;
		expect(signInLink(styled)).toBe(LINK);
	});

	test("waits for the whole link before answering", () => {
		const cut = `If the browser didn't open, visit: ${LINK.slice(0, 120)}`;
		expect(signInLink(cut)).toBeNull();
		expect(signInLink("Opening browser to sign in…\r\n")).toBeNull();
	});

	test("sees Claude asking for the code", () => {
		expect(asksForCode(WINDOWS_OUTPUT)).toBe(true);
		expect(asksForCode("\x1b[1mPaste code\x1b[0m here if prompted >")).toBe(
			true,
		);
		expect(asksForCode(`If the browser didn't open, visit: ${LINK}\r\n`)).toBe(
			false,
		);
	});
});

describe("claude on PATH", () => {
	test("on Windows, looks for claude.exe and claude.cmd in each folder", () => {
		expect(
			claudeOnPath(
				"C:\\Users\\dan\\.local\\bin;C:\\Program Files\\nodejs;",
				"win32",
			),
		).toEqual([
			"C:\\Users\\dan\\.local\\bin\\claude.exe",
			"C:\\Users\\dan\\.local\\bin\\claude.cmd",
			"C:\\Users\\dan\\.local\\bin\\claude",
			"C:\\Program Files\\nodejs\\claude.exe",
			"C:\\Program Files\\nodejs\\claude.cmd",
			"C:\\Program Files\\nodejs\\claude",
		]);
	});

	test("on macOS, looks for claude alone", () => {
		expect(claudeOnPath("/opt/homebrew/bin:/usr/bin", "darwin")).toEqual([
			"/opt/homebrew/bin/claude",
			"/usr/bin/claude",
		]);
	});
});
