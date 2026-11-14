import { expect, test } from "bun:test";
import { startedPane, waitingTasks } from "./started-pane";

test("a launch that failed is an error the phone shows, not an empty answer", () => {
	expect(startedPane('{"paneId":"p1"}')).toEqual({ paneId: "p1" });
	expect(startedPane("No backlog task has those ids.")).toEqual({});
	expect(() =>
		startedPane('{"error":"No room on the host."}', "Saved, not started: "),
	).toThrow("Saved, not started: No room on the host.");
});

test("a task whose session ended is not back in the phone's Backlog", () => {
	const fresh = { id: "a", started: false, ran: false };
	const ended = { id: "b", started: false, ran: true };
	const open = { id: "c", started: true, ran: true };
	const fromOlderWindow = { id: "d", started: false };
	expect(waitingTasks([fresh, ended, open, fromOlderWindow])).toEqual([
		fresh,
		fromOlderWindow,
	]);
});
