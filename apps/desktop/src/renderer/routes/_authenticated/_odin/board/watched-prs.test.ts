import { expect, test } from "bun:test";
import { watchedPullRequests } from "./brief";

const said = (text: string) => ({ role: "assistant" as const, text, at: null });
const urls = (...args: Parameters<typeof watchedPullRequests>) =>
	watchedPullRequests(...args)
		.map((pr) => pr.url)
		.sort();

test("a PR you attached to the brief is watched", () => {
	expect(
		urls(null, { messages: [] }, [
			{ url: "https://github.com/o/r/pull/7", name: "the fix" },
			"https://github.com/o/r/pull/8",
			"https://x.slack.com/archives/C1/p1790165128883119",
		]),
	).toEqual(["https://github.com/o/r/pull/7", "https://github.com/o/r/pull/8"]);
});

test("a PR printed before the transcript's tail is watched", () => {
	// `messages` keeps only the last turns; `links` covers the whole session.
	expect(
		urls(null, {
			messages: [said("All green, waiting on review.")],
			links: [said("Opened https://github.com/o/r/pull/3")],
		}),
	).toEqual(["https://github.com/o/r/pull/3"]);
});

test("the launch PR, printed PRs and attached PRs, each once", () => {
	expect(
		urls(
			"Review it\nhttps://github.com/o/r/pull/1",
			{
				messages: [],
				links: [said("https://github.com/o/r/pull/2 and /pull/1 again")],
			},
			["https://github.com/o/r/pull/2", "https://github.com/o/r/pull/1"],
		),
	).toEqual(["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]);
});

test("no transcript yet still watches the launch PR and attached ones", () => {
	expect(
		urls("t\nhttps://github.com/o/r/pull/4", undefined, [
			"https://github.com/o/r/pull/5",
		]),
	).toEqual(["https://github.com/o/r/pull/4", "https://github.com/o/r/pull/5"]);
});
