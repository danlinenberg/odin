import { expect, test } from "bun:test";
import { mergeTurns } from "./TranscriptView";

test("consecutive same-role turns read as one reply", () => {
	const turns = mergeTurns([
		{ role: "user", text: "fix it", at: "1" },
		{ role: "assistant", text: "Looking.", at: "2" },
		{ role: "assistant", text: "Fixed.", at: "3" },
		{ role: "user", text: "thanks", at: "4" },
	]);
	expect(turns).toEqual([
		{ role: "user", text: "fix it", at: "1" },
		{ role: "assistant", text: "Looking.\n\nFixed.", at: "2" },
		{ role: "user", text: "thanks", at: "4" },
	]);
});
