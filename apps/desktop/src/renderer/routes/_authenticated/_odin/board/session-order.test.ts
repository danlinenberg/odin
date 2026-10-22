import { describe, expect, it } from "bun:test";
import type { PaneStatus } from "renderer/stores/tabs/types";
import { type OrderedCard, sessionOrder, statusAt } from "./session-order";

type Card = OrderedCard & { title: string };

function card(
	title: string,
	status: PaneStatus,
	odinStatusAt?: number,
	odinStarred = false,
): Card {
	return { title, status, pane: { odinStatusAt, odinStarred } };
}

const byTitle = (c: Card) => c.title;
const titles = (cards: Card[]) => cards.map((c) => c.title);
const sorted = (
	cards: Card[],
	sort: Parameters<typeof sessionOrder>[0],
	grouped: boolean,
) => titles(cards.toSorted(sessionOrder(sort, grouped, byTitle)));

describe("sessionOrder", () => {
	it("Last update: the session that entered its state most recently comes first", () => {
		const cards = [
			card("older", "working", 100),
			card("newer", "working", 300),
			card("middle", "working", 200),
		];
		expect(sorted(cards, "updated", true)).toEqual([
			"newer",
			"middle",
			"older",
		]);
	});

	it("a session keeps its place while it works - only its state stamp counts", () => {
		// Hooks fire on every tool call; none of that reaches the comparator.
		// The same two cards sort the same way however many renders go by.
		const a = card("a", "working", 200);
		const b = card("b", "working", 100);
		const order = sessionOrder("updated", true, byTitle);
		expect(titles([b, a].toSorted(order))).toEqual(["a", "b"]);
		expect(titles([a, b].toSorted(order))).toEqual(["a", "b"]);
	});

	it("ties keep the order they came in", () => {
		const cards = [
			card("first", "working", 100),
			card("second", "working", 100),
			card("third", "working", 100),
		];
		expect(sorted(cards, "updated", true)).toEqual([
			"first",
			"second",
			"third",
		]);
		expect(sorted(cards, "oldest", true)).toEqual(["first", "second", "third"]);
	});

	it("Waiting longest: the session in its state longest comes first", () => {
		const cards = [
			card("newer", "permission", 300),
			card("older", "permission", 100),
			card("none", "permission"),
		];
		expect(sorted(cards, "oldest", false)).toEqual(["none", "older", "newer"]);
	});

	it("grouped: Needs you, then Done, then Working, whatever the sort", () => {
		const cards = [
			card("w", "working", 900),
			card("d", "review", 500),
			card("n", "permission", 100),
		];
		expect(sorted(cards, "updated", true)).toEqual(["n", "d", "w"]);
		expect(sorted(cards, "oldest", true)).toEqual(["n", "d", "w"]);
		expect(sorted(cards, "name", true)).toEqual(["n", "d", "w"]);
	});

	it("ungrouped Last update mixes states by their stamp", () => {
		const cards = [
			card("w", "working", 900),
			card("d", "review", 500),
			card("n", "permission", 100),
		];
		expect(sorted(cards, "updated", false)).toEqual(["w", "d", "n"]);
	});

	it("Needs you first: Needs you and Done above Working, newest first within", () => {
		const cards = [
			card("w2", "working", 900),
			card("n1", "permission", 100),
			card("w1", "working", 800),
			card("d1", "review", 200),
		];
		expect(sorted(cards, "status", false)).toEqual(["d1", "n1", "w2", "w1"]);
	});

	it("starred sessions lead their group", () => {
		const cards = [
			card("n", "permission", 900),
			card("starred n", "permission", 100, true),
			card("starred w", "working", 150, true),
			card("w", "working", 900),
		];
		expect(sorted(cards, "updated", true)).toEqual([
			"starred n",
			"n",
			"starred w",
			"w",
		]);
		// Ungrouped, stars go above everything.
		expect(sorted(cards, "updated", false)).toEqual([
			"starred w",
			"starred n",
			"n",
			"w",
		]);
	});

	it("Name sorts by title within a group", () => {
		const cards = [card("beta", "working", 900), card("alpha", "working", 100)];
		expect(sorted(cards, "name", true)).toEqual(["alpha", "beta"]);
	});

	it("Recently viewed: the session you opened last comes first, unopened ones last", () => {
		const cards = [
			card("never", "working", 900),
			card("yesterday", "working", 100),
			card("just now", "working", 200),
		];
		const viewedAt = (c: Card) =>
			({ yesterday: 10, "just now": 20 })[c.title] ?? 0;
		expect(
			titles(cards.toSorted(sessionOrder("viewed", false, byTitle, viewedAt))),
		).toEqual(["just now", "yesterday", "never"]);
	});

	it("statusAt reads the stamp, 0 when there is none", () => {
		expect(statusAt(card("x", "working", 42))).toBe(42);
		expect(statusAt(card("x", "working"))).toBe(0);
	});
});
