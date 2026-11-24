import { afterEach, describe, expect, it } from "bun:test";
import { blockedMove, usePendingFocus } from "./usePendingFocus";

describe("blockedMove", () => {
	afterEach(() => usePendingFocus.getState().setShown(null));

	it("lets a move through when no session is open", () => {
		expect(blockedMove(undefined)).toBeNull();
	});

	it("refuses another session's move while one is open", () => {
		usePendingFocus.getState().setShown("pane-a");
		expect(blockedMove(undefined)).toContain("Not done");
		expect(blockedMove("pane-b")).toContain("Not done");
	});

	it("lets the open session itself move the window", () => {
		usePendingFocus.getState().setShown("pane-a");
		expect(blockedMove("pane-a")).toBeNull();
	});
});
