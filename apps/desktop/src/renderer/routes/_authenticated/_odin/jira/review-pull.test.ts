import { expect, test } from "bun:test";
import type { PullRequestRow } from "lib/trpc/routers/work";
import { reviewPullFor } from "./review-pull";

const pull = (over: Partial<PullRequestRow>): PullRequestRow => ({
	id: 1,
	number: 1,
	url: "https://github.com/o/r/pull/1",
	title: "",
	repo: "o/r",
	author: "me",
	kind: "mine",
	draft: false,
	updated: null,
	comments: 0,
	...over,
});

test("a ticket is for my review when my PR or a review request names its key", () => {
	const mine = pull({ id: 1, title: "BUGT-4032: publish HDR XMP task" });
	const asked = pull({ id: 2, kind: "review", body: "Fixes RND-14641" });
	expect(reviewPullFor("BUGT-4032", [mine])).toBe(mine);
	expect(reviewPullFor("RND-14641", [asked])).toBe(asked);
});

test("drafts, mere mentions and a longer key don't count", () => {
	const pulls = [
		pull({ id: 1, title: "BUGT-4032: wip", draft: true }),
		pull({ id: 2, title: "BUGT-4032: see this", kind: "mentioned" }),
		pull({ id: 3, title: "BUGT-40321: other ticket" }),
	];
	expect(reviewPullFor("BUGT-4032", pulls)).toBeUndefined();
});
