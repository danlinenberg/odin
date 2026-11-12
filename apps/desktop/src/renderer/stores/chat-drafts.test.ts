import { expect, test } from "bun:test";
import {
	draftFor,
	draftKeeper,
	SAVE_AFTER_MS,
	useChatDrafts,
} from "./chat-drafts";

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

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("a box's draft saves once typing pauses and comes back after a restart", async () => {
	const box = draftKeeper("new-session");
	expect(box.initial).toBe("");
	box.type("Fix the login");
	expect(draftFor("new-session")).toBe("");
	await wait(SAVE_AFTER_MS + 50);
	expect(draftFor("new-session")).toBe("Fix the login");
	// A window reload or a restart builds a new keeper from the store.
	expect(draftKeeper("new-session").initial).toBe("Fix the login");
});

test("flush saves at once, for a reload in the middle of typing", () => {
	const box = draftKeeper("quick-add-task");
	box.type("Call Alex about the invoice");
	box.flush();
	expect(draftFor("quick-add-task")).toBe("Call Alex about the invoice");
});

test("sending clears the draft, and the sent text is never written back", async () => {
	const box = draftKeeper("pane-1");
	box.type("Ship it");
	// Sent before the pause: the pending save must not bring it back.
	box.sent();
	expect(draftFor("pane-1")).toBe("");
	await wait(SAVE_AFTER_MS + 50);
	expect(draftFor("pane-1")).toBe("");
	// A box that unmounts still showing the sent text.
	box.flush();
	expect(draftFor("pane-1")).toBe("");
	// The next message is a draft again.
	box.type("And the docs");
	box.flush();
	expect(draftFor("pane-1")).toBe("And the docs");
});
