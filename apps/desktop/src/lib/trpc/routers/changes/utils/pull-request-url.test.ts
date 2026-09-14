import { describe, expect, test } from "bun:test";
import {
	buildPullRequestCompareUrl,
	normalizeGitHubRepoUrl,
	parseUpstreamRef,
} from "./pull-request-url";

describe("pull-request-url", () => {
	test("normalizes GitHub remote URLs", () => {
		expect(
			normalizeGitHubRepoUrl("https://github.com/danlinenberg/odin.git"),
		).toBe("https://github.com/danlinenberg/odin");
		expect(normalizeGitHubRepoUrl("git@github.com:Kitenite/odin.git")).toBe(
			"https://github.com/Kitenite/odin",
		);
		expect(
			normalizeGitHubRepoUrl("ssh://git@github.com/Kitenite/odin.git"),
		).toBe("https://github.com/Kitenite/odin");
	});

	test("parses upstream refs with slashes in branch names", () => {
		expect(parseUpstreamRef("kitenite/kitenite/halved-position")).toEqual({
			remoteName: "kitenite",
			branchName: "kitenite/halved-position",
		});
	});

	test("builds compare URLs for fork branches", () => {
		expect(
			buildPullRequestCompareUrl({
				baseRepoUrl: "https://github.com/danlinenberg/odin.git",
				baseBranch: "main",
				headRepoOwner: "Kitenite",
				headBranch: "kitenite/halved-position",
			}),
		).toBe(
			"https://github.com/danlinenberg/odin/compare/main...Kitenite:kitenite/halved-position?expand=1",
		);
	});
});
