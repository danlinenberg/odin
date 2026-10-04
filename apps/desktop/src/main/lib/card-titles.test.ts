import { expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a card's last title outlives its pane", async () => {
	const home = mkdtempSync(join(tmpdir(), "card-titles-"));
	mock.module("./app-environment", () => ({ ODIN_HOME_DIR: home }));
	const { cardTitles, rememberCardTitles } = await import("./card-titles");
	rememberCardTitles({
		a: { claudeSessionId: "s1", odinTaskTitle: "First name" },
		shell: {},
	});
	rememberCardTitles({
		a: { claudeSessionId: "s1", odinTaskTitle: "Renamed" },
	});
	// The card closed: its pane is gone from the next save.
	rememberCardTitles({});
	expect(cardTitles()).toEqual({ s1: "Renamed" });
	expect(
		JSON.parse(readFileSync(join(home, "card-titles.json"), "utf8")),
	).toEqual({ s1: "Renamed" });
});
