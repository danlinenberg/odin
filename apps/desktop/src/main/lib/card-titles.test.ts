import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardTitles, rememberCardTitles } from "./card-titles";

test("a card's last title outlives its pane", () => {
	const path = join(mkdtempSync(join(tmpdir(), "card-titles-")), "t.json");
	rememberCardTitles(
		{ a: { claudeSessionId: "s1", odinTaskTitle: "First name" }, shell: {} },
		path,
	);
	rememberCardTitles(
		{ a: { claudeSessionId: "s1", odinTaskTitle: "Renamed" } },
		path,
	);
	// The card closed: its pane is gone from the next save.
	rememberCardTitles({}, path);
	expect(cardTitles(path)).toEqual({ s1: "Renamed" });
});
