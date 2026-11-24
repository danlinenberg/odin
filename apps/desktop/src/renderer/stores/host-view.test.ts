import { describe, expect, test } from "bun:test";
import {
	hostScreenToWindow,
	openHostScreen,
	showHostScreen,
	useHostView,
} from "./host-view";

describe("host view", () => {
	test("a screen moved to its own window leaves the drawer until it is opened there again", () => {
		showHostScreen("p1", { port: 5901, password: "pw" });
		expect(useHostView.getState().open).toBe("p1");
		hostScreenToWindow("p1");
		expect(useHostView.getState().open).toBeNull();
		expect(useHostView.getState().inWindow.p1).toBe(true);
		openHostScreen("p1");
		expect(useHostView.getState().open).toBe("p1");
		expect(useHostView.getState().inWindow.p1).toBeUndefined();
		hostScreenToWindow("p1");
		showHostScreen("p1", { port: 5902, password: "pw2" });
		expect(useHostView.getState().inWindow.p1).toBeUndefined();
	});
});
