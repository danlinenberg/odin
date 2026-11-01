import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardProfiles, cardTitles, rememberCardTitles } from "./card-titles";

test("a card's last title outlives its pane", () => {
	const dir = mkdtempSync(join(tmpdir(), "card-titles-"));
	const path = join(dir, "t.json");
	const profiles = join(dir, "p.json");
	rememberCardTitles(
		{
			a: { claudeSessionId: "s1", odinTaskTitle: "First name" },
			b: { claudeSessionId: "s2", odinProfile: "personal" },
			shell: {},
		},
		path,
		profiles,
	);
	rememberCardTitles(
		{ a: { claudeSessionId: "s1", odinTaskTitle: "Renamed" } },
		path,
		profiles,
	);
	// The cards closed: their panes are gone from the next save.
	rememberCardTitles({}, path, profiles);
	expect(cardTitles(path)).toEqual({ s1: "Renamed" });
	// An unstamped pane is the default profile's.
	expect(cardProfiles(profiles)).toEqual({ s1: "default", s2: "personal" });
});
