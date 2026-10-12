import { expect, test } from "bun:test";
import { useCrowChats } from "./crow-chats";

test("keeps the 20 newest chats, and a resumed one moves to the top", () => {
	const { save } = useCrowChats.getState();
	for (let i = 0; i < 25; i++)
		save({ sessionId: `${i}`, title: `chat ${i}`, cwd: "/w", at: i });
	save({ sessionId: "10", title: "chat 10", cwd: "/w", at: 99 });
	const ids = useCrowChats.getState().chats.map((c) => c.sessionId);
	expect(ids).toHaveLength(20);
	expect(ids.slice(0, 2)).toEqual(["10", "24"]);
	expect(ids.filter((id) => id === "10")).toHaveLength(1);
	expect(ids).not.toContain("4");
});
