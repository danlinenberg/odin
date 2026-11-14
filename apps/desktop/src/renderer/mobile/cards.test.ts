import { expect, test } from "bun:test";
import { boardSections, remoteCloud } from "./cards";

test("a column lists starred first, then by last activity", () => {
	const row = (paneId: string, statusAt: number | null, starred = false) =>
		({ paneId, title: paneId, column: "idle", statusAt, starred }) as never;
	const idle = boardSections([
		row("old", 1),
		row("new", 3),
		row("never", null),
		row("star", 0, true),
	]).find((s) => s.key === "idle");
	expect(idle?.rows.map((r) => r.paneId)).toEqual([
		"star",
		"new",
		"old",
		"never",
	]);
});

test("Ping me sessions waiting on someone else get their own section above Idle", () => {
	const row = (paneId: string, column: string, waiting?: true) =>
		({ paneId, title: paneId, column, statusAt: 0, waiting }) as never;
	const sections = boardSections([
		row("ping", "idle", true),
		row("idle", "idle"),
		row("needs", "permission"),
	]);
	expect(sections.map((s) => s.key)).toEqual([
		"permission",
		"working",
		"review",
		"waiting",
		"idle",
	]);
	const rows = (key: string) =>
		sections.find((s) => s.key === key)?.rows.map((r) => r.paneId);
	expect(rows("waiting")).toEqual(["ping"]);
	expect(rows("idle")).toEqual(["idle"]);
	// No Ping me session waiting: no empty section for it.
	expect(
		boardSections([row("idle", "idle")]).some((s) => s.key === "waiting"),
	).toBe(false);
});

test("a remote card's cloud wears the colour of its link to the host", () => {
	expect(remoteCloud(true).className).toBe("text-success");
	expect(remoteCloud(false).className).toBe("text-danger");
	expect(remoteCloud(false).label).toBe("Remote, offline");
	// An older Odin sends no state: a plain cloud, no claim either way.
	expect(remoteCloud(undefined).className).toBe("text-foreground");
});
