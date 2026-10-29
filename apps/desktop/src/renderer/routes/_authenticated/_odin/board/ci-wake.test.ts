import { expect, test } from "bun:test";
import {
	CI_RETRIES,
	type CiWake,
	ciWakeMessage,
	ciWakePlan,
	gaveUpPanes,
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
