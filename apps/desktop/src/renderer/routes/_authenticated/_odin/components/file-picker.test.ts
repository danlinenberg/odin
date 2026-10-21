import { describe, expect, test } from "bun:test";
import { fileToken, insertFile, matchFiles } from "./file-picker";

const FILES = [
	"README.md",
	"apps/desktop/src/renderer/routes/_authenticated/_odin/board/ChatView.tsx",
	"apps/desktop/src/renderer/routes/_authenticated/_odin/components/skill-picker.ts",
	"apps/desktop/src/lib/trpc/routers/skills.ts",
	"apps/desktop/package.json",
	"package.json",
	"docs/chat.md",
];

describe("fileToken", () => {
	test("opens on an @ token at the end", () => {
		expect(fileToken("@")).toBe("");
		expect(fileToken("look at @chat")).toBe("chat");
		expect(fileToken("look at @apps/desktop/")).toBe("apps/desktop/");
	});

	test("stays closed otherwise", () => {
		expect(fileToken("")).toBeUndefined();
		expect(fileToken("look at @chat and fix it")).toBeUndefined();
		// An email address, not a mention
		expect(fileToken("mail dan@imagen")).toBeUndefined();
		// Already picked: the space after it closes the picker
		expect(fileToken("@README.md ")).toBeUndefined();
	});
});

describe("matchFiles", () => {
	test("a name that starts with the text comes first", () => {
		expect(matchFiles(FILES, "skill")).toEqual([
			"apps/desktop/src/lib/trpc/routers/skills.ts",
			"apps/desktop/src/renderer/routes/_authenticated/_odin/components/skill-picker.ts",
		]);
	});

	test("a name match beats a folder match, then letters along the name", () => {
		expect(matchFiles(FILES, "chat")).toEqual([
			"docs/chat.md",
			"apps/desktop/src/renderer/routes/_authenticated/_odin/board/ChatView.tsx",
		]);
		expect(matchFiles(FILES, "docs")).toEqual(["docs/chat.md"]);
		expect(matchFiles(FILES, "chtvw")).toEqual([
			"apps/desktop/src/renderer/routes/_authenticated/_odin/board/ChatView.tsx",
		]);
	});

	test("ignores case", () => {
		expect(matchFiles(FILES, "READ")).toEqual(["README.md"]);
		expect(matchFiles(FILES, "chatview")).toHaveLength(1);
	});

	test("nearer the root first, on equal fit", () => {
		expect(matchFiles(FILES, "package")).toEqual([
			"package.json",
			"apps/desktop/package.json",
		]);
	});

	test("an empty token lists the shallow files first, capped", () => {
		expect(matchFiles(FILES, "", 3)).toEqual([
			"README.md",
			"package.json",
			"docs/chat.md",
		]);
	});

	test("no match, no list", () => {
		expect(matchFiles(FILES, "zzz")).toEqual([]);
	});
});

describe("insertFile", () => {
	test("replaces the token with the path and a space", () => {
		expect(insertFile("look at @chat", "docs/chat.md")).toBe(
			"look at @docs/chat.md ",
		);
		expect(insertFile("@", "README.md")).toBe("@README.md ");
	});

	test("quotes a path with a space in it", () => {
		expect(insertFile("@my", "docs/my notes.md")).toBe('@"docs/my notes.md" ');
	});

	test("keeps what was typed before", () => {
		expect(insertFile("compare @a with @pack", "package.json")).toBe(
			"compare @a with @package.json ",
		);
	});
});
