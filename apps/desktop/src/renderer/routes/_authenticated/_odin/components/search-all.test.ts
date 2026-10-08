import { expect, test } from "bun:test";
import type { Pane } from "shared/tabs-types";
import {
	boardSessions,
	groupResults,
	isClosedStatus,
	matchRank,
	rankRows,
	rankSessions,
	type SessionHit,
	TRANSCRIPT_TIER,
} from "./search-all";

const row = (
	title: string,
	extra: {
		source?: string;
		person?: string;
		context?: string;
		done?: boolean;
	} = {},
) => ({
	title,
	source: extra.source ?? "Jira",
	person: extra.person ?? null,
	context: extra.context ?? null,
	status: null,
	done: extra.done ?? false,
});

const session = (
	paneId: string,
	title: string,
	extra: Partial<SessionHit> = {},
): SessionHit => ({
	paneId,
	title,
	status: "idle",
	contact: null,
	repo: null,
	brief: null,
	tags: [],
	...extra,
});

const titles = (hits: { item: { title: string } }[]) =>
	hits.map((hit) => hit.item.title);

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

test("transcript hits rank below every field match", () => {
	expect(TRANSCRIPT_TIER).toBeGreaterThan(3);
});

test("best tier first, then open before done, then the order given", () => {
	const rows = [
		row("Review the deploy"),
		row("Deploy the old thing", { done: true }),
		row("BUGT-1: deploy breaks"),
		row("Deploy the thing"),
		row("Redeploy it"),
		row("Unrelated"),
	];
	expect(titles(rankRows("Deploy", rows))).toEqual([
		"Deploy the thing",
		"Deploy the old thing",
		"Review the deploy",
		"BUGT-1: deploy breaks",
		"Redeploy it",
	]);
});

test("nothing typed lists everything, open first", () => {
	const rows = [row("a", { done: true }), row("b"), row("c")];
	expect(titles(rankRows("  ", rows))).toEqual(["b", "c", "a"]);
});

test("a Jira key or a PR number in the title finds the row", () => {
	const rows = [row("BUGT-12: It breaks"), row("odin#7: Fix it")];
	expect(titles(rankRows("bugt-12", rows))).toEqual(["BUGT-12: It breaks"]);
	expect(titles(rankRows("#7", rows))).toEqual(["odin#7: Fix it"]);
});

test("rows match on who and where", () => {
	const rows = [row("can you look", { person: "Ada", context: "#eng" })];
	expect(rankRows("ada", rows)).toEqual([{ item: rows[0], tier: 3 }]);
	expect(rankRows("#eng", rows)).toHaveLength(1);
});

test("board cards match on contact, repo, brief and tags", () => {
	const sessions = [
		session("p1", "Fix it", {
			repo: "odin",
			contact: "Ada",
			brief: "the flaky deploy",
			tags: ["urgent"],
		}),
	];
	for (const query of ["odin", "ada", "flaky", "urgent"])
		expect(rankSessions(query, sessions)).toHaveLength(1);
	expect(rankSessions("grace", sessions)).toEqual([]);
});

test("closed reads the same in every source's words", () => {
	for (const status of ["Done", "closed", "Resolved", "Won't Do", "Merged"])
		expect(isClosedStatus(status)).toBe(true);
	for (const status of ["In progress", "Open", "To Do", null])
		expect(isClosedStatus(status)).toBe(false);
});

test("groups: best hit's source first, capped, expandable, empty ones dropped", () => {
	const hits = (tiers: number[]) =>
		tiers.map((tier, i) => ({ item: `${tier}.${i}`, tier }));
	const groups = [
		{ id: "Jira", hits: hits([2, 3, 3]) },
		{ id: "Slack", hits: hits([0]) },
		{ id: "Email", hits: [] },
		{ id: "History", hits: hits([4, 4, 4, 4]) },
	];
	expect(groupResults(groups, 2, new Set())).toEqual([
		{ id: "Slack", items: ["0.0"], more: 0 },
		{ id: "Jira", items: ["2.0", "3.1"], more: 1 },
		{ id: "History", items: ["4.0", "4.1"], more: 2 },
	]);
	expect(groupResults(groups, 2, new Set(["History"]))[2]).toEqual({
		id: "History",
		items: ["4.0", "4.1", "4.2", "4.3"],
		more: 0,
	});
});

const pane = (id: string, extra: Partial<Pane> = {}): Pane => ({
	id,
	tabId: "t1",
	type: "terminal",
	name: "Terminal",
	odinTaskTitle: `Session ${id}`,
	...extra,
});

test("the board's cards: every column, Odin-launched terminals in this profile", () => {
	const panes = {
		live: pane("live", { status: "working", cwd: "/Users/dan/dev/odin" }),
		mine: pane("mine", { odinTaskTitle: undefined }),
		legacy: pane("legacy", { odinTaskTitle: undefined, status: "review" }),
		chat: pane("chat", { type: "chat" }),
		killed: pane("killed", { completed: true }),
		orphan: pane("orphan", { tabId: "gone" }),
		other: pane("other", { odinProfile: "work" }),
		asks: pane("asks", { status: "permission" }),
	};
	const mirror = {
		titles: { legacy: "From the old mirror" },
		contacts: { legacy: "Ada" },
		briefs: {},
	};
	const hits = boardSessions(panes, new Set(["t1"]), "default", mirror);
	expect(hits.map((hit) => hit.paneId)).toEqual(["asks", "live", "legacy"]);
	expect(hits[1]).toMatchObject({ title: "Session live", repo: "odin" });
	expect(hits[2]).toMatchObject({
		title: "From the old mirror",
		contact: "Ada",
	});
	expect(
		boardSessions(panes, new Set(["t1"]), "work").map((hit) => hit.paneId),
	).toEqual(["other"]);
});
