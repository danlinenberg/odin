import { describe, expect, test } from "bun:test";
import {
	currentHostScreen,
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

	test("an older View button opens the session's current viewer, not the stale port it was given", () => {
		const stale = { port: 5901, password: "old" };
		// Nothing on record for the session yet: the button's own screen.
		expect(currentHostScreen("p2", stale)).toEqual(stale);
		// The app restarted on the host and a later reply shared it again.
		useHostView.setState((state) => ({
			byPane: { ...state.byPane, p2: { port: 5907, password: "new" } },
		}));
		expect(currentHostScreen("p2", stale)).toEqual({
			port: 5907,
			password: "new",
		});
		showHostScreen("p2", currentHostScreen("p2", stale));
		expect(useHostView.getState().byPane.p2).toEqual({
			port: 5907,
			password: "new",
		});
		// Another session's viewer never stands in.
		expect(currentHostScreen("p3", stale)).toEqual(stale);
	});
});
