import { describe, expect, test } from "bun:test";
import { provenanceLabel } from "./provenance";

describe("provenanceLabel", () => {
	test("a Jira key reads as itself", () => {
		expect(provenanceLabel("jira", "PROJ-1481")).toBe("PROJ-1481");
	});

	test("a PR url collapses to repo#number", () => {
		expect(
			provenanceLabel("pr", "https://github.com/danlinenberg/odin/pull/812"),
		).toBe("odin#812");
	});

	test("a PR url from somewhere else still says what it is", () => {
		expect(provenanceLabel("pr", "https://git.internal/x/y/-/merge/3")).toBe(
			"Pull request",
		);
	});

	test("ids nobody can read show the source instead", () => {
		expect(provenanceLabel("reactions", "C08AB1C2D:1757834521.123")).toBe(
			"Slack",
		);
		expect(
			provenanceLabel("notion", "1f2e3d4c-5b6a-7980-9012-3456789abcde"),
		).toBe("Notion");
	});
});
