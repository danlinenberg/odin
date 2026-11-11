import { expect, test } from "bun:test";
import { useTabsStore } from "./store";
import type { Pane } from "./types";

test("Done on a pane its tab left behind drops it", () => {
	const ghost = { id: "ghost", tabId: "gone", type: "chat", name: "x" } as Pane;
	useTabsStore.setState({ tabs: [], panes: { ghost } });
	useTabsStore.getState().removePane("ghost");
	expect(useTabsStore.getState().panes.ghost).toBeUndefined();
});
