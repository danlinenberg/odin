import { expect, test } from "bun:test";
import { startedPane } from "./started-pane";

test("a launch that failed is an error the phone shows, not an empty answer", () => {
	expect(startedPane('{"paneId":"p1"}')).toEqual({ paneId: "p1" });
	expect(startedPane("No backlog task has those ids.")).toEqual({});
	expect(() =>
		startedPane('{"error":"No room on the host."}', "Saved, not started: "),
	).toThrow("Saved, not started: No room on the host.");
});
