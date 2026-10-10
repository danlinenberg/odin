import { expect, test } from "bun:test";
import { draftFor, useChatDrafts } from "./chat-drafts";

test("keeps the 50 newest drafts and drops a sent one", () => {
	const { save } = useChatDrafts.getState();
	for (let i = 0; i < 60; i++) save(`${i}`, `text ${i}`);
	save("12", "edited");
	expect(useChatDrafts.getState().drafts).toHaveLength(50);
	expect(draftFor("59")).toBe("text 59");
	expect(draftFor("12")).toBe("edited");
	expect(draftFor("9")).toBe("");
	save("59", "");
	expect(draftFor("59")).toBe("");
});
