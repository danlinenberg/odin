import { describe, expect, test } from "bun:test";
import type { Pane } from "shared/tabs-types";
import { paneSchema } from ".";

/**
 * Panes are persisted through `paneSchema`, and zod drops every key the schema
 * doesn't list — which has silently eaten `userTitle`, `completed`,
 * `claudeSessionId` and `odinProfile` in turn. `Required<Pane>` makes adding a
 * field to the type a compile error here, and the round-trip fails if the
 * schema then forgets it.
 */
describe("paneSchema", () => {
	test("keeps every field of a pane", () => {
		const pane: Required<Pane> = {
			id: "p1",
			tabId: "t1",
			type: "terminal",
			name: "claude",
			userTitle: "My session",
			isNew: false,
			status: "working",
			interrupted: false,
			completed: false,
			claudeSessionId: "11111111-2222-3333-4444-555555555555",
			odinTaskTitle: "BUGT-1: fix the thing",
			odinContact: "dan",
			odinBrief: "a brief",
			odinPageId: "page-1",
			odinSource: "jira",
			odinTags: ["work"],
			odinAutoTagged: true,
			odinAutoTitled: true,
			odinProfile: "1d14929a-66cb-4664-b2b1-a655fd00677f",
			odinParked: false,
			odinShellPaneId: "p3",
			initialCwd: "/tmp",
			url: "https://example.com",
			cwd: "/tmp",
			cwdConfirmed: true,
			fileViewer: {
				filePath: "/tmp/a.ts",
				viewMode: "rendered",
				isPinned: false,
				diffLayout: "inline",
			},
			chat: { sessionId: null },
			browser: {
				currentUrl: "https://example.com",
				history: [],
				historyIndex: 0,
				isLoading: false,
			},
			devtools: { targetPaneId: "p2" },
			comment: {
				commentId: "c1",
				authorLogin: "danlinenberg",
				avatarUrl: "https://example.com/a.png",
				body: "nit",
				url: "https://github.com/x/y/pull/1",
				path: "a.ts",
				line: 3,
			},
			workspaceRun: { workspaceId: "w1", state: "running" },
		};
		expect(paneSchema.parse(pane)).toEqual(pane);
	});
});
