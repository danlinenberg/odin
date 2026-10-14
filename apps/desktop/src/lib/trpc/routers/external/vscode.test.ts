import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import {
	claudeCodeSessionUrl,
	hasClaudeCodeExtension,
	vscodeFolderUrl,
	vscodeWindowReady,
} from "./vscode";

describe("vscodeFolderUrl", () => {
	test("macOS path with spaces", () => {
		expect(vscodeFolderUrl("/Users/a/my repo", "darwin")).toBe(
			"vscode://file/Users/a/my%20repo",
		);
	});

	test("Windows path", () => {
		expect(vscodeFolderUrl("C:\\code\\odin", "win32")).toBe(
			"vscode://file/C:/code/odin",
		);
	});
});

test("claudeCodeSessionUrl", () => {
	expect(claudeCodeSessionUrl("1b2c3d4e-0000-4000-8000-000000000000")).toBe(
		"vscode://anthropic.claude-code/open?session=1b2c3d4e-0000-4000-8000-000000000000",
	);
});

describe("hasClaudeCodeExtension", () => {
	test("finds the extension folder", () => {
		const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vsx-"));
		expect(hasClaudeCodeExtension(dir)).toBe(false);
		fs.mkdirSync(
			nodePath.join(dir, "anthropic.claude-code-2.1.0-darwin-arm64"),
		);
		expect(hasClaudeCodeExtension(dir)).toBe(true);
	});

	test("no VS Code extensions folder", () => {
		expect(hasClaudeCodeExtension("/nonexistent/extensions")).toBe(false);
	});
});

describe("vscodeWindowReady", () => {
	test("true once a VS Code lock file lists the folder", () => {
		const ide = fs.mkdtempSync(nodePath.join(os.tmpdir(), "ide-"));
		const folder = fs.mkdtempSync(nodePath.join(os.tmpdir(), "repo-"));
		expect(vscodeWindowReady(folder, ide)).toBe(false);
		fs.writeFileSync(
			nodePath.join(ide, "1.lock"),
			JSON.stringify({ ideName: "Neovim", workspaceFolders: [folder] }),
		);
		expect(vscodeWindowReady(folder, ide)).toBe(false);
		fs.writeFileSync(
			nodePath.join(ide, "2.lock"),
			JSON.stringify({
				ideName: "Visual Studio Code",
				workspaceFolders: [fs.realpathSync(folder)],
			}),
		);
		expect(vscodeWindowReady(folder, ide)).toBe(true);
	});

	test("no ide folder", () => {
		expect(vscodeWindowReady("/x", "/nonexistent/ide")).toBe(false);
	});
});
