import { expect, test } from "bun:test";
import { matchRepos } from "./repo-picker";

const REPOS = [
	"/Users/dan/dev/imagen/app-web-server",
	"/Users/dan/dev/imagen/imagen-web-admin",
	"/Users/dan/dev/imagen/internal-claude",
	"/Users/dan/dev/odin/packages/odin-cli",
	"/Users/dan/dev/private/odin",
];

test("blank matches nothing", () => {
	expect(matchRepos(REPOS, "")).toEqual([]);
	expect(matchRepos(REPOS, "   ")).toEqual([]);
});

test("takes the full path the datalist fills in", () => {
	expect(matchRepos(REPOS, "/Users/dan/dev/private/odin")).toEqual([
		"/Users/dan/dev/private/odin",
	]);
});

test("a repo's own name wins over the same word in other paths", () => {
	expect(matchRepos(REPOS, "odin")).toEqual(["/Users/dan/dev/private/odin"]);
	expect(matchRepos(REPOS, "INTERNAL-CLAUDE")).toEqual([
		"/Users/dan/dev/imagen/internal-claude",
	]);
});

test("otherwise all typed words must appear in the path", () => {
	expect(matchRepos(REPOS, "imagen app")).toEqual([
		"/Users/dan/dev/imagen/app-web-server",
	]);
	expect(matchRepos(REPOS, "nope")).toEqual([]);
	// Ambiguous: the caller shows the count instead of picking one.
	expect(matchRepos(REPOS, "imagen web")).toHaveLength(2);
});
