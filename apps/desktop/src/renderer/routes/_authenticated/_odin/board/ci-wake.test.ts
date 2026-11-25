import { expect, test } from "bun:test";
import { fixConflictsMessage } from "./brief";
import {
	CI_RETRIES,
	type CiWake,
	CONFLICT_RETRIES,
	type ConflictsByPr,
	type ConflictWake,
	ciWakeMessage,
	ciWakePlan,
	conflictWakeMessage,
	conflictWakePlan,
	conflictWoke,
	gaveUpPanes,
	wakesColumn,
	woke,
} from "./ci-wake";

const URL = "https://github.com/o/r/pull/7";
const SINCE = Date.parse("2026-10-29T08:00:00Z");
const pr = (sha: string, at = "2026-10-29T09:00:00Z") => ({
	state: "OPEN",
	failed: ["test"],
	pending: [] as string[],
	headSha: sha,
	failedAt: at,
});
const red = (sha: string, at?: string) => ({ [URL]: pr(sha, at) });

test("a red run wakes the session once", () => {
	const first = ciWakePlan(undefined, red("a"), SINCE);
	expect(first.wakes).toEqual([
		{ url: URL, sha: "a", failed: ["test"], run: 1 },
	]);
	const records = woke(first.next, first.wakes[0] as CiWake);
	expect(ciWakePlan(records, red("a"), SINCE).wakes).toEqual([]);
});

test("a session that could not take it is tried again next poll", () => {
	const first = ciWakePlan(undefined, red("a"), SINCE);
	expect(ciWakePlan(first.next, red("a"), SINCE).wakes).toHaveLength(1);
});

test("while checks run nothing happens", () => {
	const plan = ciWakePlan(
		undefined,
		{ [URL]: { ...pr("a"), pending: ["build"] } },
		SINCE,
	);
	expect(plan.wakes).toEqual([]);
});

test("a red run from before the feature ran is recorded, not sent", () => {
	const old = ciWakePlan(undefined, red("a", "2026-10-28T09:00:00Z"), SINCE);
	expect(old.wakes).toEqual([]);
	expect(ciWakePlan(old.next, red("a"), SINCE).wakes).toEqual([]);
	expect(ciWakePlan(old.next, red("b"), SINCE).wakes[0]?.run).toBe(1);
});

test("after the cap of red runs in a row the card waits for you", () => {
	let records = {};
	for (let i = 1; i <= CI_RETRIES; i++) {
		const plan = ciWakePlan(records, red(`s${i}`), SINCE);
		expect(plan.wakes[0]?.run).toBe(i);
		records = woke(plan.next, plan.wakes[0] as CiWake);
	}
	const last = ciWakePlan(records, red("final"), SINCE);
	expect(last.wakes).toEqual([]);
	expect(gaveUpPanes({ p: last.next })).toEqual(["p"]);
});

test("green, merged or someone else's PR ends the streak", () => {
	const plan = ciWakePlan(undefined, red("a"), SINCE);
	const records = woke(plan.next, plan.wakes[0] as CiWake);
	const green = { ...pr("b"), failed: [] };
	expect(ciWakePlan(records, { [URL]: green }, SINCE).next).toEqual({});
	const merged = { ...pr("b"), state: "MERGED" };
	expect(ciWakePlan(records, { [URL]: merged }, SINCE).next).toEqual({});
	const theirs = { ...pr("b"), mine: false };
	expect(ciWakePlan(undefined, { [URL]: theirs }, SINCE).wakes).toEqual([]);
});

test("the message names the checks and carries the log", () => {
	const text = ciWakeMessage({ url: URL, sha: "a", failed: ["test"], run: 2 }, [
		{ name: "test", link: "https://x/job/1", log: "expected 1, received 2" },
	]);
	expect(text).toContain("CI failed on PR #7");
	expect(text).toContain("expected 1, received 2");
	expect(text).toContain(`red run 2 of ${CI_RETRIES}`);
});

test("the CI message says not to patch a check the base branch also fails", () => {
	const text = ciWakeMessage(
		{ url: URL, sha: "a", failed: ["test"], run: 1 },
		[],
	);
	expect(text).toContain("whether the base branch fails the same check");
	expect(text).toContain("don't patch around it here");
	expect(text).toContain("update this branch once that fix is merged");
	expect(text).toContain("say so in one line");
});

const conflicting = (head: string, base = "m1", extra = {}) => ({
	[URL]: {
		state: "OPEN",
		conflicting: true,
		headSha: head,
		baseSha: base,
		base: "main",
		...extra,
	},
});

test("a conflicting PR sends the brief's conflict prompt once per head + base pair", () => {
	const first = conflictWakePlan(undefined, conflicting("a"));
	expect(first.wakes).toEqual([
		{ url: URL, pair: "a:m1", base: "main", try: 1 },
	]);
	const wake = first.wakes[0] as ConflictWake;
	expect(conflictWakeMessage(wake)).toBe(fixConflictsMessage(URL, "main"));
	const records = conflictWoke(first.next, wake);
	expect(conflictWakePlan(records, conflicting("a")).wakes).toEqual([]);
	// Not taken yet (the session was busy): tried again next poll.
	expect(conflictWakePlan(first.next, conflicting("a")).wakes).toHaveLength(1);
	// The base moved: a new pair, a second try.
	expect(conflictWakePlan(records, conflicting("a", "m2")).wakes).toEqual([
		{ url: URL, pair: "a:m2", base: "main", try: 2 },
	]);
});

test("after 3 tries on the same PR the card waits for you", () => {
	let records: ConflictsByPr = {};
	for (const head of ["a", "b", "c"]) {
		const plan = conflictWakePlan(records, conflicting(head));
		records = conflictWoke(plan.next, plan.wakes[0] as ConflictWake);
	}
	const fourth = conflictWakePlan(records, conflicting("d"));
	expect(CONFLICT_RETRIES).toBe(3);
	expect(fourth.wakes).toEqual([]);
	expect(fourth.next[URL]?.gaveUp).toBe(true);
	expect(gaveUpPanes({ p1: fourth.next })).toEqual(["p1"]);
	// It stays given up until the conflict is gone.
	expect(conflictWakePlan(fourth.next, conflicting("e")).wakes).toEqual([]);
});

test("a PR that stops conflicting ends the streak; a teammate's or a closed one never wakes", () => {
	const plan = conflictWakePlan(undefined, conflicting("a"));
	const records = conflictWoke(plan.next, plan.wakes[0] as ConflictWake);
	expect(
		conflictWakePlan(records, conflicting("b", "m1", { conflicting: false }))
			.next,
	).toEqual({});
	expect(
		conflictWakePlan(undefined, conflicting("a", "m1", { mine: false })).wakes,
	).toEqual([]);
	expect(
		conflictWakePlan(undefined, conflicting("a", "m1", { state: "MERGED" }))
			.wakes,
	).toEqual([]);
});

test("the wakes watch Working and Idle cards too, not one you parked", () => {
	for (const column of ["permission", "review", "working", "idle"])
		expect(wakesColumn(column, false)).toBe(true);
	expect(wakesColumn("idle", true)).toBe(false);
});

test("a red run left on the same commit wakes again once the base moves", () => {
	const HOUR = 60 * 60_000;
	const t0 = Date.parse("2026-10-29T10:00:00Z");
	const onBase = (base: string) => ({ [URL]: { ...pr("a"), baseSha: base } });
	const first = ciWakePlan(undefined, onBase("m1"), SINCE, t0);
	const records = woke(first.next, first.wakes[0] as CiWake, t0);
	// Same base: nothing new.
	expect(ciWakePlan(records, onBase("m1"), SINCE, t0 + 2 * HOUR).wakes).toEqual(
		[],
	);
	// Base moved, but too soon after the last wake.
	expect(
		ciWakePlan(records, onBase("m2"), SINCE, t0 + 10 * 60_000).wakes,
	).toEqual([]);
	const later = ciWakePlan(records, onBase("m2"), SINCE, t0 + HOUR);
	expect(later.wakes).toHaveLength(1);
	expect(later.wakes[0]).toMatchObject({ run: 2, base: "m2", baseMoved: true });
	expect(ciWakeMessage(later.wakes[0] as CiWake, [])).toContain(
		"the base branch has moved since",
	);
	// Counts toward the cap like any other red run.
	const capped = { [URL]: { sha: "a", wakes: CI_RETRIES, base: "m1", at: t0 } };
	expect(ciWakePlan(capped, onBase("m9"), SINCE, t0 + 5 * HOUR).wakes).toEqual(
		[],
	);
});
