import { beforeEach, describe, expect, it } from "bun:test";
import { useStartingPanes } from "./starting-panes";

describe("useStartingPanes", () => {
	beforeEach(() => useStartingPanes.setState({ ids: [] }));

	it("holds a pane from the card appearing until its PTY is up", () => {
		useStartingPanes.getState().add("pane-1");
		expect(useStartingPanes.getState().ids).toEqual(["pane-1"]);
		useStartingPanes.getState().remove("pane-1");
		expect(useStartingPanes.getState().ids).toEqual([]);
	});

	it("lists a pane once however many times its launch adds it", () => {
		useStartingPanes.getState().add("pane-1");
		useStartingPanes.getState().add("pane-1");
		expect(useStartingPanes.getState().ids).toEqual(["pane-1"]);
	});

	it("removing a pane it never held changes nothing", () => {
		useStartingPanes.getState().add("pane-1");
		const before = useStartingPanes.getState().ids;
		useStartingPanes.getState().remove("pane-2");
		expect(useStartingPanes.getState().ids).toBe(before);
	});
});
