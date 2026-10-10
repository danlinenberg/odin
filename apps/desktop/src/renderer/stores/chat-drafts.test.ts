import { expect, test } from "bun:test";
import { useChatDrafts } from "./chat-drafts";

test("keeps the 50 newest drafts and drops a sent one", () => {
	const { save } = useChatDrafts.getState();
	for (let i = 0; i < 60; i++) save(`pane-${i}`, `text ${i}`);
	const drafts = useChatDrafts.getState().drafts;
	expect(Object.keys(drafts)).toHaveLength(50);
	expect(drafts["pane-59"]?.text).toBe("text 59");
	expect(drafts["pane-10"]).toBeDefined();
	expect(drafts["pane-9"]).toBeUndefined();
	save("pane-59", "");
	expect(useChatDrafts.getState().drafts["pane-59"]).toBeUndefined();
});
