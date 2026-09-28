import { describe, expect, it } from "bun:test";
import { usePaneMeta } from "./usePaneMeta";

describe("forgetPane", () => {
	it("drops every entry for the removed pane and keeps the others", () => {
		const s = usePaneMeta.getState();
		s.setTitle("p1", "gone");
		s.setBrief("p1", "gone");
		s.setContact("p1", "dan");
		s.setNotes("p1", "gone");
		s.setSessionId("p1", "sess-1");
		s.setPaneForPage("page-1", "p1");
		s.setTitle("p2", "stays");
		s.setPaneForPage("page-2", "p2");

		s.forgetPane("p1");

		const after = usePaneMeta.getState();
		expect(after.titleByPane).toEqual({ p2: "stays" });
		expect(after.briefByPane.p1).toBeUndefined();
		expect(after.contactByPane.p1).toBeUndefined();
		expect(after.notesByPane.p1).toBeUndefined();
		expect(after.sessionIdByPane.p1).toBeUndefined();
		// reverse map: the page must look session-less again, p2's link intact
		expect(after.paneByPage).toEqual({ "page-2": "p2" });
	});
});

describe("setNotes", () => {
	it("keeps a note and removes the key when it's cleared", () => {
		const s = usePaneMeta.getState();
		s.setNotes("p3", "check the migration");
		expect(usePaneMeta.getState().notesByPane.p3).toBe("check the migration");

		s.setNotes("p3", "   ");
		expect("p3" in usePaneMeta.getState().notesByPane).toBe(false);
	});
});

describe("Done then resume", () => {
	it("hands your notes and links to the resumed conversation's new pane", () => {
		const s = usePaneMeta.getState();
		s.setNotes("old", "ping QA after deploy");
		s.addLink("old", "https://x.test/doc", "doc");
		s.setHidden("old", "https://x.test/noise", true);

		s.forgetPane("old", "sess-9");
		expect(usePaneMeta.getState().notesByPane.old).toBeUndefined();

		s.adoptSession("new", "sess-9");
		const after = usePaneMeta.getState();
		expect(after.notesByPane.new).toBe("ping QA after deploy");
		expect(after.linksByPane.new).toEqual([
			{ url: "https://x.test/doc", name: "doc" },
		]);
		expect(after.hiddenByPane.new).toEqual(["https://x.test/noise"]);
		expect(after.keptBySession["sess-9"]).toBeUndefined();
	});
});
