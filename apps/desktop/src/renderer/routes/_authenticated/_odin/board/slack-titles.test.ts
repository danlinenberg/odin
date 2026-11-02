import { describe, expect, test } from "bun:test";
import { rawSlackTitles } from "./slack-titles";

describe("card titles in Slack's raw markup", () => {
	test("picks a title with a mention, a channel or @here", () => {
		expect(
			rawSlackTitles({
				a: { odinTaskTitle: "<@U0B16MXKZRT> Users who shouldn't get it" },
				b: { odinTaskTitle: "Add it in <#C0C29460Y73>" },
				c: { odinTaskTitle: "<!here> deploy" },
				d: { odinTaskTitle: "@Dan Linenberg can you check" },
				e: { odinTaskTitle: "a < b and x <= y" },
				f: {},
			}),
		).toEqual({
			a: "<@U0B16MXKZRT> Users who shouldn't get it",
			b: "Add it in <#C0C29460Y73>",
			c: "<!here> deploy",
		});
	});
});
