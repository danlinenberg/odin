import { describe, expect, test } from "bun:test";
import { drawerViewSwitch } from "./drawer-view-switch";

describe("drawerViewSwitch", () => {
	test("the chat shows: its composer has Terminal View, the footer has none", () => {
		expect(
			drawerViewSwitch({ chat: true, peeking: false, hostScreenOpen: false }),
		).toBeNull();
	});

	test("the terminal shows: the footer offers Chat View", () => {
		expect(
			drawerViewSwitch({ chat: false, peeking: false, hostScreenOpen: false }),
		).toBe("chat");
		expect(
			drawerViewSwitch({ chat: true, peeking: true, hostScreenOpen: false }),
		).toBe("chat");
	});

	test("the app covers the chat: the footer goes back to Chat View", () => {
		expect(
			drawerViewSwitch({ chat: true, peeking: false, hostScreenOpen: true }),
		).toBe("chat");
	});

	test("the app covers the terminal: the footer goes back to Terminal View", () => {
		expect(
			drawerViewSwitch({ chat: false, peeking: false, hostScreenOpen: true }),
		).toBe("terminal");
		expect(
			drawerViewSwitch({ chat: true, peeking: true, hostScreenOpen: true }),
		).toBe("terminal");
	});
});
