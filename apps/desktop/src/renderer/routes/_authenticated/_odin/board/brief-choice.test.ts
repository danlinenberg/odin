import { expect, test } from "bun:test";
import { splitActionItems } from "./action-items";
import { actionItems } from "./brief";

const reply =
	"Hila's model is better.\n\nDecision for you: which should I add?\n[Model 1+2 and the skill | Skill only | Leave as is]";

test("a trailing choice without an ACTION ITEMS line is read as one item", () => {
	const { body, actions } = splitActionItems(reply);
	expect(body).toBe("Hila's model is better.");
	expect(actions).toBe(
		"1. Decision for you: which should I add? [Model 1+2 and the skill | Skill only | Leave as is]",
	);
	expect(
		actionItems([{ role: "assistant", text: reply, at: null }]),
	).toHaveLength(1);
});

test("replies without a trailing choice, or with the heading, are unchanged", () => {
	expect(
		splitActionItems("Done. See [a | b] above.\n\nAll shipped.").actions,
	).toBeNull();
	expect(splitActionItems("x\n\n```\necho [a | b]\n```").actions).toBeNull();
	expect(splitActionItems("x\n\nACTION ITEMS\n1. Pick [a | b]").actions).toBe(
		"1. Pick [a | b]",
	);
});
