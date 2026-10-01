import { describe, expect, test } from "bun:test";
import {
	type NotionComment,
	openMentionThreads,
	propsNamingMe,
} from "./mentions";

const ME = "me";
const comment = (
	id: string,
	thread: string,
	at: string,
	by: string,
	tagsMe = false,
): NotionComment => ({
	id,
	discussion_id: thread,
	created_time: at,
	created_by: { id: by },
	rich_text: tagsMe
		? [{ type: "mention", mention: { type: "user", user: { id: ME } } }]
		: [{ type: "text", plain_text: "hi" }],
});

describe("openMentionThreads", () => {
	test("a thread that tags me and waits on me is open", () => {
		const open = openMentionThreads(
			[comment("c1", "t1", "2026-01-01", "ann", true)],
			ME,
		);
		expect(open.map((t) => t.comment.id)).toEqual(["c1"]);
	});

	test("my reply after the tag closes it", () => {
		const open = openMentionThreads(
			[
				comment("c2", "t1", "2026-01-02", ME),
				comment("c1", "t1", "2026-01-01", "ann", true),
			],
			ME,
		);
		expect(open).toEqual([]);
	});

	test("a thread that never tags me is not mine", () => {
		expect(
			openMentionThreads([comment("c1", "t1", "2026-01-01", "ann")], ME),
		).toEqual([]);
	});

	test("someone else replying after me reopens it", () => {
		const open = openMentionThreads(
			[
				comment("c1", "t1", "2026-01-01", "ann", true),
				comment("c2", "t1", "2026-01-02", ME),
				comment("c3", "t1", "2026-01-03", "bob"),
			],
			ME,
		);
		expect(open[0]?.latestAt).toBe("2026-01-03");
	});
});

describe("propsNamingMe", () => {
	test("names the people properties that list me, and only those", () => {
		expect(
			propsNamingMe(
				{
					Assignee: { type: "people", people: [{ id: "ann" }, { id: ME }] },
					Reporter: { type: "people", people: [{ id: "ann" }] },
					Status: { type: "status" },
				},
				ME,
			),
		).toEqual(["Assignee"]);
	});
});
