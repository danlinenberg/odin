import { describe, expect, it } from "bun:test";
import {
	dueLabel,
	itemKind,
	pilotPick,
	plainLine,
	rankToday,
	shouldShowToday,
	type TodayEntry,
	type TodayGroup,
	todayCounts,
	todayGroup,
	todayGroups,
	todayLanes,
	todayTasks,
	todayTitle,
	yourAction,
} from "./today";

describe("todayGroup", () => {
	it("a working or queued session is running", () => {
		expect(todayGroup({ column: "working" })).toBe("running");
		expect(todayGroup({ column: "idle", queued: true })).toBe("running");
	});

	it("waiting on someone wins over the column", () => {
		expect(todayGroup({ column: "idle", waitingOn: "Alex" })).toBe("waiting");
		expect(todayGroup({ column: "review", waitingOn: "" })).toBe("waiting");
	});

	it("only a merge or nothing left is almost done", () => {
		expect(todayGroup({ column: "review", almostDone: true })).toBe(
			"almost-done",
		);
		expect(todayGroup({ column: "review", urgency: "fyi" })).toBe(
			"almost-done",
		);
	});

	it("a question or an asking reply needs you", () => {
		expect(todayGroup({ column: "permission" })).toBe("needs-you");
		expect(todayGroup({ column: "review", urgency: "needs-you" })).toBe(
			"needs-you",
		);
		expect(todayGroup({ column: "review" })).toBe("needs-you");
	});

	it("idle and parked are on hold", () => {
		expect(todayGroup({ column: "idle" })).toBe("paused");
		expect(todayGroup({ column: "idle", parked: true })).toBe("paused");
	});
});

describe("todayGroups", () => {
	it("keeps the group order and drops empty groups", () => {
		const groups = todayGroups([
			{ key: "a", group: "paused" },
			{ key: "b", group: "running" },
			{ key: "c", group: "needs-you" },
		]);
		expect(groups.map((g) => g.group)).toEqual([
			"needs-you",
			"running",
			"paused",
		]);
	});

	it("orders by nearest due date, then priority, then star, then board order", () => {
		const groups = todayGroups([
			{ key: "plain", group: "needs-you" },
			{ key: "later", group: "needs-you", due: "2026-11-20" },
			{ key: "starred", group: "needs-you", starred: true },
			{ key: "high", group: "needs-you", urgency: "high" },
			{ key: "overdue", group: "needs-you", due: "2026-11-10" },
			{ key: "plain2", group: "needs-you" },
			{ key: "low", group: "needs-you", urgency: "low" },
		]);
		expect(groups[0].items.map((i) => i.key)).toEqual([
			"overdue",
			"later",
			"high",
			"low",
			"starred",
			"plain",
			"plain2",
		]);
	});
});

describe("todayCounts", () => {
	it("says how many sit in each group", () => {
		expect(
			todayCounts([
				{ group: "needs-you" },
				{ group: "needs-you" },
				{ group: "running" },
				{ group: "waiting" },
			]),
		).toBe("2 need you, 1 running, 1 waiting on someone");
		expect(todayCounts([{ group: "needs-you" }])).toBe("1 needs you");
		expect(todayCounts([])).toBe("Nothing open");
	});
});

describe("dueLabel", () => {
	it("reads the distance in days", () => {
		expect(dueLabel("2026-11-01", -3)).toBe("Overdue");
		expect(dueLabel("2026-11-15", 0)).toBe("Due today");
		expect(dueLabel("2026-11-16", 1)).toBe("Due tomorrow");
		expect(dueLabel("2026-11-19", 4)).toBe("Due in 4 days");
		expect(dueLabel("2026-12-01", 16)).toBe("Due 2026-12-01");
	});
});

describe("plainLine", () => {
	it("drops PR numbers, ticket keys, links and hashes", () => {
		expect(
			plainLine(
				"PR #123 is green; ABC-42 waits on review (see https://example.com/x), commit 1a2b3c4d.",
			),
		).toBe("the pull request is green; waits on review, commit.");
		expect(plainLine("Fixed the login bug (#77)")).toBe("Fixed the login bug");
		expect(plainLine(null)).toBe("");
	});
});

describe("shouldShowToday", () => {
	const base = { enabled: true, lastShown: "2026-11-14", today: "2026-11-15" };
	it("opens once a day when there is open work", () => {
		expect(shouldShowToday({ ...base, count: 2 })).toBe(true);
		expect(
			shouldShowToday({ ...base, lastShown: "2026-11-15", count: 2 }),
		).toBe(false);
	});
	it("stays shut when off or when nothing is open", () => {
		expect(shouldShowToday({ ...base, enabled: false, count: 2 })).toBe(false);
		expect(shouldShowToday({ ...base, count: 0 })).toBe(false);
	});
});

describe("todayTasks", () => {
	const item = (
		key: string,
		group: TodayEntry["group"],
		extra: Partial<TodayEntry & { status: string; goal: string }> = {},
	) => ({ key, group, title: `Session ${key}`, status: null, ...extra });

	it("says what a task is about from its session's goal until the model does", () => {
		const tasks = todayTasks(
			[{ keys: ["a"], name: "Sign-in", about: null, line: null }],
			[
				item("a", "needs-you", { goal: "Let new users finish sign-in" }),
				item("b", "running", { goal: "Export reports to CSV" }),
			],
		);
		expect(tasks.map((t) => [t.name, t.about])).toEqual([
			["Sign-in", "Let new users finish sign-in"],
			["Session b", "Export reports to CSV"],
		]);
	});

	it("groups sessions as written, most pressing task and session first", () => {
		const tasks = todayTasks(
			[
				{ keys: ["run", "ask"], name: "Sign-in", about: "Why", line: "Where" },
				{ keys: ["idle"], name: "Export", about: null, line: null },
			],
			[
				item("idle", "paused", { due: "2026-11-19" }),
				item("run", "running"),
				item("ask", "needs-you"),
			],
		);
		expect(
			tasks.map((t) => [t.name, t.id, t.group, t.items.map((i) => i.key)]),
		).toEqual([
			["Sign-in", "ask", "needs-you", ["ask", "run"]],
			["Export", "idle", "paused", ["idle"]],
		]);
	});

	it("gives a session the model left out a task of its own, and drops closed ones", () => {
		const tasks = todayTasks(
			[{ keys: ["gone"], name: "Closed work", about: null, line: null }],
			[item("new", "running", { status: "PR #12 is green" })],
		);
		expect(tasks).toEqual([
			{
				id: "new",
				name: "Session new",
				about: null,
				explain: null,
				line: "the pull request is green",
				left: null,
				next: null,
				group: "running",
				items: [expect.objectContaining({ key: "new" })],
			},
		]);
	});

	it("puts a session in the first task that names it", () => {
		const tasks = todayTasks(
			[
				{ keys: ["a"], name: "One", about: null, line: null },
				{ keys: ["a", "b"], name: "Two", about: null, line: null },
			],
			[item("a", "running"), item("b", "running")],
		);
		expect(tasks.map((t) => [t.name, t.items.length])).toEqual([
			["One", 1],
			["Two", 1],
		]);
	});
});

describe("yourAction", () => {
	it("turns your next step into an action", () => {
		expect(yourAction("You: pick the email wording.")).toBe(
			"Pick the email wording",
		);
		expect(yourAction("you : merge it")).toBe("Merge it");
	});
	it("is null when someone else acts", () => {
		expect(yourAction("Claude: is writing the test")).toBeNull();
		expect(yourAction("Riley: confirm the rows")).toBeNull();
		expect(yourAction(null)).toBeNull();
	});
});

describe("todayLanes", () => {
	it("puts what waits on you first and keeps the order", () => {
		const t = (id: string, group: TodayGroup, next: string | null = null) => ({
			id,
			group,
			next,
		});
		const { yours, moving } = todayLanes([
			t("a", "needs-you"),
			t("b", "running", "You: review it after"),
			t("c", "almost-done"),
			t("d", "paused", "You: decide if it still matters"),
			t("e", "waiting", "Riley: confirm"),
		]);
		expect(yours.map((x) => x.id)).toEqual(["a", "c", "d"]);
		expect(moving.map((x) => x.id)).toEqual(["b", "e"]);
	});
});

describe("rankToday", () => {
	const at = (key: string, group: TodayGroup, due?: string) => ({
		key,
		group,
		due: due ?? null,
	});
	it("due now first, then quick wins, then questions, then the rest", () => {
		const ranked = rankToday(
			[
				at("question", "needs-you"),
				at("running", "running"),
				at("merge", "almost-done"),
				at("overdue", "running", "2026-01-01"),
				at("later", "needs-you", "2099-01-01"),
			],
			"2026-06-01",
		);
		expect(ranked.map((e) => e.key)).toEqual([
			"overdue",
			"merge",
			"later",
			"question",
			"running",
		]);
	});
});

describe("todayTitle and itemKind", () => {
	const task = { name: "CSV export", group: "needs-you" as const, next: null };
	it("the first action item titles the card, its choices left out", () => {
		expect(todayTitle(task, "Pick the wording [Short | Long]")).toBe(
			"Pick the wording",
		);
		expect(todayTitle({ ...task, next: "You: merge it" })).toBe("Merge it");
		expect(todayTitle({ ...task, group: "almost-done" })).toBe(
			"Finish: CSV export",
		);
	});
	it("a kind word per item", () => {
		expect(itemKind("Approve the plan")).toBe("Approve");
		expect(itemKind("Pick one [A | B]")).toBe("Answer");
		expect(itemKind("Merge the pull request")).toBe("Merge");
		expect(itemKind("Test it on your phone")).toBe("Do");
	});
});

describe("pilotPick", () => {
	it("takes the first task you haven't answered", () => {
		expect(pilotPick(["a", "b", "c"], new Set(["a"]), [])).toBe("b");
	});
	it("puts skipped tasks last, in the order skipped", () => {
		expect(pilotPick(["a", "b", "c"], new Set(), ["b", "a"])).toBe("c");
		expect(pilotPick(["a", "b"], new Set(), ["b", "a"])).toBe("b");
	});
	it("is null when nothing is left", () => {
		expect(pilotPick(["a"], new Set(["a"]), [])).toBeNull();
		expect(pilotPick([], new Set(), ["x"])).toBeNull();
	});
});
