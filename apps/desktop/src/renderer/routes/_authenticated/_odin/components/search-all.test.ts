import { expect, test } from "bun:test";
import type { Pane } from "shared/tabs-types";
import {
	boardSessions,
	matchRank,
	type SessionHit,
	searchAll,
} from "./search-all";

const row = (
	title: string,
	extra: { source?: string; person?: string; context?: string } = {},
) => ({
	title,
	source: extra.source ?? "Jira",
	person: extra.person ?? null,
	context: extra.context ?? null,
	status: null,
});

const session = (paneId: string, title: string): SessionHit => ({
	paneId,
	title,
	status: "idle",
	source: "normal",
	contact: null,
	repo: null,
});

test("title start beats a word in the title beats anywhere in it", () => {
	expect(matchRank("fix", "Fix the login", [])).toBe(0);
	expect(matchRank("login", "Fix the login", [])).toBe(1);
	expect(matchRank("ogin", "Fix the login", [])).toBe(2);
	expect(matchRank("nope", "Fix the login", [])).toBeNull();
});

test("every word has to turn up somewhere, title or extra fields", () => {
	expect(matchRank("login ada", "Fix the login", ["Ada", null])).toBe(3);
	expect(matchRank("login grace", "Fix the login", ["Ada", null])).toBeNull();
	expect(matchRank("slack", "can you look", ["Slack"])).toBe(3);
});

test("blank lists the first of each, in the order given", () => {
	const rows = [row("a"), row("b"), row("c")];
	const sessions = [session("p1", "one"), session("p2", "two")];
	expect(searchAll("  ", rows, sessions, 2)).toEqual({
		sessions,
		rows: [rows[0], rows[1]],
	});
});

test("best match first, ties keep the given order", () => {
	const rows = [
		row("Review the deploy"),
		row("BUGT-1: deploy breaks"),
		row("Deploy the thing"),
		row("Redeploy it"),
		row("Unrelated"),
	];
	expect(searchAll("Deploy", rows, []).rows.map((r) => r.title)).toEqual([
		"Deploy the thing",
		"Review the deploy",
		"BUGT-1: deploy breaks",
		"Redeploy it",
	]);
});

test("a Jira key or a PR number in the title finds the row", () => {
	const rows = [row("BUGT-12: It breaks"), row("odin#7: Fix it")];
	expect(searchAll("bugt-12", rows, []).rows).toEqual([rows[0]]);
	expect(searchAll("#7", rows, []).rows).toEqual([rows[1]]);
});

test("rows match on who and where, sessions on contact and repo", () => {
	const rows = [row("can you look", { person: "Ada", context: "#eng" })];
	const sessions = [{ ...session("p1", "Fix it"), repo: "odin" }];
	expect(searchAll("ada", rows, sessions)).toEqual({ sessions: [], rows });
	expect(searchAll("odin", rows, sessions)).toEqual({ sessions, rows: [] });
});

test("caps each list at the limit", () => {
	const rows = Array.from({ length: 5 }, (_, i) => row(`task ${i}`));
	expect(searchAll("task", rows, [], 3).rows).toHaveLength(3);
});

const pane = (id: string, extra: Partial<Pane> = {}): Pane => ({
	id,
	tabId: "t1",
	type: "terminal",
	name: "Terminal",
	odinTaskTitle: `Session ${id}`,
	...extra,
});

test("the board's sessions: Odin-launched terminals in this profile", () => {
	const panes = {
		live: pane("live", { status: "working", cwd: "/Users/dan/dev/odin" }),
		mine: pane("mine", { odinTaskTitle: undefined }),
		chat: pane("chat", { type: "chat" }),
		killed: pane("killed", { completed: true }),
		orphan: pane("orphan", { tabId: "gone" }),
		other: pane("other", { odinProfile: "work" }),
		asks: pane("asks", { status: "permission" }),
	};
	const hits = boardSessions(panes, new Set(["t1"]), "default");
	expect(hits.map((hit) => hit.paneId)).toEqual(["asks", "live"]);
	expect(hits[1]).toMatchObject({ title: "Session live", repo: "odin" });
	expect(
		boardSessions(panes, new Set(["t1"]), "work").map((hit) => hit.paneId),
	).toEqual(["other"]);
});
