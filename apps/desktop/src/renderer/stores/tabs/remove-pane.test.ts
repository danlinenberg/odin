import { expect, test } from "bun:test";
import { useTabsStore } from "./store";
import type { Pane } from "./types";

test("Done on a pane its tab left behind drops it", () => {
	const ghost = { id: "ghost", tabId: "gone", type: "chat", name: "x" } as Pane;
	useTabsStore.setState({ tabs: [], panes: { ghost } });
	useTabsStore.getState().removePane("ghost");
	expect(useTabsStore.getState().panes.ghost).toBeUndefined();
});

test("a change written onto a pane that already closed doesn't stay as a pane with no id", () => {
	const whole = { id: "whole", tabId: "t", type: "chat", name: "x" } as Pane;
	useTabsStore.setState({ tabs: [], panes: { whole } });
	// What a late title or status does when its pane is gone.
	useTabsStore.setState((state) => ({
		panes: {
			...state.panes,
			closed: { ...state.panes.closed, status: "idle" } as Pane,
		},
	}));
	expect(Object.keys(useTabsStore.getState().panes)).toEqual(["whole"]);
});
