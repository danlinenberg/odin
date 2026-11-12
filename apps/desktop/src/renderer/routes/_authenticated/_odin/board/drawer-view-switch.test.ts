import { describe, expect, test } from "bun:test";
import { drawerViewSwitch } from "./drawer-view-switch";

describe("drawerViewSwitch", () => {
	test("the chat shows: its composer has Terminal View, the footer has none", () => {
		expect(
			drawerViewSwitch({ chat: true, peeking: false, hostScreenOpen: false }),
		).toBeNull();
	});

	test("the app's screen covers the chat: the footer offers Terminal View", () => {
		expect(
			drawerViewSwitch({ chat: true, peeking: false, hostScreenOpen: true }),
		).toBe("terminal");
	});

	test("the terminal is the choice: the footer offers Chat View", () => {
		expect(
			drawerViewSwitch({ chat: false, peeking: false, hostScreenOpen: false }),
		).toBe("chat");
	});

	test("the app's screen covers the terminal: the footer offers Terminal View, not Chat View", () => {
		expect(
			drawerViewSwitch({ chat: false, peeking: false, hostScreenOpen: true }),
		).toBe("terminal");
		expect(
			drawerViewSwitch({ chat: true, peeking: true, hostScreenOpen: true }),
		).toBe("terminal");
	});

	test("a question peek shows the terminal: the footer offers Chat View", () => {
		expect(
			drawerViewSwitch({ chat: true, peeking: true, hostScreenOpen: false }),
		).toBe("chat");
	});
});
