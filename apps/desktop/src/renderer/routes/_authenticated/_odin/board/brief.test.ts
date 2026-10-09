import { describe, expect, it } from "bun:test";
import {
	actionItems,
	artifactLink,
	type BriefMessage,
	ciRunning,
	elapsedLabel,
	emailLink,
	jiraIssue,
	jiraKey,
	lastMessageAt,
	launchPullRequest,
	linkContext,
	linkKind,
	linkLabel,
	linkRefs,
	mergeReady,
	mergeTargets,
	nextCronFire,
	notionPage,
	onlyLookLeft,
	onlyMergeLeft,
	parseLinks,
	postedMessage,
	projectSlug,
	prsDropped,
	pullRequests,
	reviewEnded,
	reviewedPullRequest,
	sessionBrief,
	slackThread,
	sourceLink,
} from "./brief";

const user = (text: string, at: string | null = null): BriefMessage => ({
	role: "user",
	text,
	at,
});
const claude = (text: string, at: string | null = null): BriefMessage => ({
	role: "assistant",
	text,
	at,
});

const REPORT = `Fixed the drawer focus race - ${"x".repeat(80)}`;

describe("sessionBrief", () => {
	it("reports the agent's last substantive turn as the status", () => {
		const brief = sessionBrief([user("fix the drawer"), claude(REPORT)]);
		expect(brief.latest).toBe(REPORT);
		expect(brief.turns).toBe(2);
	});

	it("skips a trailing acknowledgement to find the real report", () => {
		const brief = sessionBrief([
			user("fix the drawer"),
			claude(REPORT),
			user("thanks"),
			claude("Done."),
		]);
		expect(brief.latest).toBe(REPORT);
	});

	it("still shows a short turn when that is all there is", () => {
		expect(sessionBrief([user("hi"), claude("Done.")]).latest).toBe("Done.");
	});

	it("surfaces the latest ask only once you have asked twice", () => {
		expect(sessionBrief([user("fix the drawer")]).lastAsk).toBeNull();
		expect(
			sessionBrief([
				user("fix the drawer"),
				claude(REPORT),
				user("now ship it"),
			]).lastAsk,
		).toBe("now ship it");
	});

	it("ignores Resume's 'continue' stub when picking the latest ask", () => {
		expect(
			sessionBrief([
				user("fix the drawer"),
				claude(REPORT),
				user("now ship it"),
				user("continue"),
			]).lastAsk,
		).toBe("now ship it");
		// Opening ask + a resume is still just the one ask.
		expect(
			sessionBrief([user("fix the drawer"), claude(REPORT), user("continue")])
				.lastAsk,
		).toBeNull();
	});

	it("takes the time from the last turn", () => {
		const brief = sessionBrief([
			user("go", "2026-08-12T10:00:00Z"),
			claude("ok", "2026-08-12T10:05:00Z"),
		]);
		expect(brief.at).toBe("2026-08-12T10:05:00Z");
	});

	it("survives an empty transcript", () => {
		expect(sessionBrief([])).toEqual({
			lastAsk: null,
			latest: null,
			turns: 0,
			at: null,
		});
	});
});

describe("pullRequests", () => {
	it("collects each PR once, most recently opened first", () => {
		expect(
			pullRequests([
				user("ship it"),
				claude(
					"Opened https://github.com/danlinenberg/odin/pull/12 for review.",
				),
				claude("Also https://github.com/imagenai/app-web-server/pull/5918"),
				// The same PR quoted again later must not double up, and must not
				// jump the queue - it was still opened first.
				claude("Merged https://github.com/danlinenberg/odin/pull/12"),
			]),
		).toEqual([
			{
				url: "https://github.com/imagenai/app-web-server/pull/5918",
				repo: "imagenai/app-web-server",
				number: 5918,
			},
			{
				url: "https://github.com/danlinenberg/odin/pull/12",
				repo: "danlinenberg/odin",
				number: 12,
			},
		]);
	});

	it("strips the markdown and prose around a link", () => {
		const prs = pullRequests([
			claude("see [the PR](https://github.com/o/r/pull/7) and note it."),
		]);
		expect(prs).toHaveLength(1);
		expect(prs[0]?.url).toBe("https://github.com/o/r/pull/7");
	});

	it("ignores issues and bare repo links", () => {
		expect(
			pullRequests([
				claude("https://github.com/o/r/issues/7"),
				claude("https://github.com/o/r"),
			]),
		).toEqual([]);
	});

	it("normalises a deep PR link back to the PR itself", () => {
		const prs = pullRequests([
			claude("https://github.com/o/r/pull/7/files#diff"),
		]);
		expect(prs).toEqual([
			{ url: "https://github.com/o/r/pull/7", repo: "o/r", number: 7 },
		]);
	});

	it("finds nothing in a session that opened nothing", () => {
		expect(pullRequests([user("hi"), claude("done")])).toEqual([]);
	});

	it("skips a PR you pasted as the input, keeps the one it opened", () => {
		expect(
			pullRequests([
				user("https://github.com/o/r/pull/6390\n\nrun it on this pr"),
				claude("Shipped as https://github.com/o/actions/pull/249"),
			]),
		).toEqual([
			{
				url: "https://github.com/o/actions/pull/249",
				repo: "o/actions",
				number: 249,
			},
		]);
	});
});

describe("projectSlug", () => {
	it("matches Claude's transcript directory naming", () => {
		expect(projectSlug("/Users/dan/dev/private/odin")).toBe(
			"-Users-dan-dev-private-odin",
		);
		expect(projectSlug("/Users/dan/.odin/x")).toBe("-Users-dan--odin-x");
	});
});

const BACKLOG = "https://app.notion.com/p/3dd9a1b573ff81eeab56d1a8065f87c7";
const ADR =
	"https://www.notion.so/imagen-ai/Spot-Instances-with-On-Demand-Fallback-3d19a1b573ff819b8237f88195e3780f";

describe("notionPage", () => {
	it("keeps one page, titled from its slug", () => {
		expect(
			notionPage([
				user("write it up"),
				claude(`Published ${BACKLOG}`),
				claude(`And the ADR: ${ADR}`),
			]),
		).toEqual({
			url: ADR,
			id: "3d19a1b573ff819b8237f88195e3780f",
			title: "Spot Instances with On Demand Fallback",
		});
	});

	it("falls back to the newest page when none is titled", () => {
		const other = "https://app.notion.com/p/3dd9a1b573ff81eeab56d1a8065f87c8";
		expect(notionPage([claude(BACKLOG), claude(other)])?.url).toBe(other);
	});

	it("takes the page the closing report leads with, not the ones it cites", () => {
		const reference =
			"https://app.notion.com/p/3419a1b573ff805792a9e77aa0acf8b0";
		expect(
			notionPage([
				claude(`Page created: ${BACKLOG}`),
				claude(
					`Done: **[the plan](${BACKLOG})**. Misfiled notes in [Meetings](${reference}), see also [the ADR](${ADR}).`,
				),
			])?.url,
		).toBe(BACKLOG);
	});

	it("treats a /p/ link and a slug link to one page as one page", () => {
		expect(
			notionPage([
				claude(`${ADR}`),
				claude(
					"https://app.notion.com/p/3d19a1b573ff819b8237f88195e3780f?pvs=204",
				),
			])?.url,
		).toBe(ADR);
	});

	it("strips the markdown and prose around a link", () => {
		expect(
			notionPage([claude(`see [the board](${BACKLOG}) and note it.`)])?.url,
		).toBe(BACKLOG);
	});

	it("ignores a Notion url carrying no page id", () => {
		expect(
			notionPage([claude("https://www.notion.so/imagen-ai"), claude("done")]),
		).toBeNull();
	});

	it("skips a page you pasted as the input", () => {
		expect(notionPage([user(`update ${BACKLOG}`), claude("done")])).toBeNull();
	});
});

describe("slackThread", () => {
	it("takes the thread the session was launched from, not later mentions", () => {
		expect(
			slackThread([
				user(
					"This task comes from a Slack thread: https://imagen.slack.com/archives/C1/p1700000001000200?thread_ts=1700000000.123456&cid=C1",
				),
				claude(
					"Also see https://imagen.slack.com/archives/C9/p1700000009000000",
				),
			]),
		).toBe(
			"https://imagen.slack.com/archives/C1/p1700000001000200?thread_ts=1700000000.123456&cid=C1",
		);
	});

	it("strips the prose around a link", () => {
		expect(
			slackThread([
				claude("(https://imagen.slack.com/archives/C1/p17000001)."),
			]),
		).toBe("https://imagen.slack.com/archives/C1/p17000001");
	});

	it("finds nothing in a session that came from nowhere", () => {
		expect(
			slackThread([user("hi"), claude("https://slack.com/api")]),
		).toBeNull();
	});
});

describe("lastMessageAt", () => {
	it("reads the newest turn's timestamp", () => {
		expect(
			lastMessageAt([
				user("go", "2026-09-10T09:00:00.000Z"),
				claude("done", "2026-09-10T09:04:00.000Z"),
			]),
		).toBe(Date.parse("2026-09-10T09:04:00.000Z"));
	});

	it("walks back past turns an older transcript left untimed", () => {
		expect(
			lastMessageAt([user("go", "2026-09-10T09:00:00.000Z"), claude("done")]),
		).toBe(Date.parse("2026-09-10T09:00:00.000Z"));
	});

	it("has nothing to report for a transcript with no timestamps", () => {
		expect(lastMessageAt([user("go"), claude("done")])).toBeNull();
		expect(lastMessageAt([])).toBeNull();
	});
});

describe("elapsedLabel", () => {
	const now = Date.parse("2026-09-10T12:00:00.000Z");
	const ago = (ms: number) => elapsedLabel(now - ms, now);
	const MIN = 60_000;

	it("counts minutes, then hours, then days", () => {
		// Rounded, so "now" holds until the half-minute.
		expect(ago(20_000)).toBe("now");
		expect(ago(5 * MIN)).toBe("5m");
		expect(ago(59 * MIN)).toBe("59m");
		expect(ago(90 * MIN)).toBe("1h 30m");
		expect(ago(23 * 60 * MIN)).toBe("23h 0m");
	});

	it("rolls over to days rather than reporting 70h", () => {
		expect(ago(24 * 60 * MIN)).toBe("1d 0h");
		expect(ago((70 * 60 + 30) * MIN)).toBe("2d 22h");
	});

	it("says nothing when there is no timestamp", () => {
		expect(elapsedLabel(undefined, now)).toBeNull();
	});
});

describe("launchPullRequest", () => {
	it("is the PR a PR row was launched on, and nothing for any other row", () => {
		expect(
			launchPullRequest(
				"imagenai/submitter-app-electron#6012: fix: stale\nhttps://github.com/imagenai/submitter-app-electron/pull/6012",
			),
		).toEqual({
			url: "https://github.com/imagenai/submitter-app-electron/pull/6012",
			repo: "imagenai/submitter-app-electron",
			number: 6012,
		});
		expect(
			launchPullRequest(
				"CRR-862\nhttps://imagen-ai.atlassian.net/browse/CRR-862",
			),
		).toBeNull();
		expect(launchPullRequest(null)).toBeNull();
	});
});

describe("sourceLink", () => {
	it("labels a Jira brief with its issue key", () => {
		expect(
			sourceLink(
				"CRR-862: Remove all default in app banners\nhttps://imagen-ai.atlassian.net/browse/CRR-862",
			),
		).toEqual({
			url: "https://imagen-ai.atlassian.net/browse/CRR-862",
			label: "CRR-862",
		});
	});

	it("falls back to the host, and drops trailing prose", () => {
		expect(
			sourceLink("odin#78\nhttps://github.com/imagenai/odin/pull/78."),
		).toEqual({
			url: "https://github.com/imagenai/odin/pull/78",
			label: "github.com",
		});
	});

	it("says nothing when the brief carries no link", () => {
		// Slack-sourced cards: the brief is the message text, not a URL.
		expect(sourceLink("Morning Dan, can you check?")).toBeNull();
		expect(sourceLink(null)).toBeNull();
	});
});

describe("jiraKey", () => {
	it("reads the key from a browse link, ignoring its query", () => {
		expect(
			jiraKey("https://imagen.atlassian.net/browse/CRR-905?atlOrigin=x"),
		).toBe("CRR-905");
		expect(jiraKey("https://example.com/CRR-905")).toBeNull();
	});
});

describe("jiraIssue", () => {
	const turn = (role: BriefMessage["role"], text: string): BriefMessage => ({
		role,
		text,
		at: null,
	});

	it("finds the ticket you pasted, without its tracking query", () => {
		const issue = jiraIssue([
			turn(
				"user",
				"https://imagen-ai.atlassian.net/browse/SHIP-1063?atlOrigin=eyJpIjoi&issueKey=SHIP-1063 add this to brief",
			),
		]);

		expect(issue).toEqual({
			key: "SHIP-1063",
			url: "https://imagen-ai.atlassian.net/browse/SHIP-1063",
		});
	});

	it("keeps the first ticket, not one quoted later", () => {
		const issue = jiraIssue([
			turn("user", "see https://imagen-ai.atlassian.net/browse/SHIP-1063"),
			turn(
				"assistant",
				"related: https://imagen-ai.atlassian.net/browse/RND-14753.",
			),
		]);

		expect(issue?.key).toBe("SHIP-1063");
	});

	it("finds nothing in a session with no ticket", () => {
		expect(jiraIssue([turn("user", "no links here")])).toBeNull();
	});
});

describe("linkLabel", () => {
	it("names the kind of thing each link is", () => {
		expect(
			linkLabel("https://acme.slack.com/archives/C123/p1700000000000100"),
		).toBe("Slack thread");
		expect(linkLabel("https://acme.slack.com/archives/C123")).toBe(
			"Slack channel",
		);
		expect(linkLabel("https://github.com/acme/odin/pull/42")).toBe("odin #42");
		expect(linkLabel("https://acme.atlassian.net/browse/SHIP-1063")).toBe(
			"SHIP-1063",
		);
		expect(
			linkLabel(
				"https://www.notion.so/Spot-Instances-0123456789abcdef0123456789abcdef",
			),
		).toBe("Spot Instances");
		expect(linkLabel("https://docs.google.com/document/d/x")).toBe(
			"Google Doc",
		);
		expect(linkLabel("https://docs.google.com/spreadsheets/d/x/edit")).toBe(
			"Google Sheet",
		);
		expect(linkLabel("https://docs.google.com/a/b")).toBe("docs.google.com");
	});
});

describe("parseLinks", () => {
	it("takes the words around a single link as its name", () => {
		expect(
			parseLinks(
				"https://acme.slack.com/archives/C1/p1700000000000100 deploy rollback",
			),
		).toEqual([
			{
				url: "https://acme.slack.com/archives/C1/p1700000000000100",
				name: "deploy rollback",
			},
		]);
		expect(parseLinks("QA sheet: https://docs.google.com/x.")).toEqual([
			{ url: "https://docs.google.com/x", name: "QA sheet" },
		]);
	});
	it("leaves several pasted links unnamed", () => {
		expect(parseLinks("see https://a.com/1 and https://b.com/2")).toEqual([
			{ url: "https://a.com/1" },
			{ url: "https://b.com/2" },
		]);
	});
});

describe("linkKind", () => {
	it("sorts a link into its brief section", () => {
		expect(linkKind("https://acme.atlassian.net/browse/SHIP-1")).toBe("jira");
		expect(
			linkKind("https://acme.slack.com/archives/C1/p1700000000000100"),
		).toBe("slack");
		expect(linkKind("https://github.com/acme/odin/pull/42")).toBe("pr");
		expect(
			linkKind("https://www.notion.so/Page-0123456789abcdef0123456789abcdef"),
		).toBe("notion");
		expect(linkKind("https://docs.google.com/x")).toBe("other");
	});
});

describe("nextCronFire", () => {
	// Local time, like CronCreate: Wed 2026-09-23 10:05.
	const from = new Date(2026, 8, 23, 10, 5, 30).getTime();
	const at = (ms: number | null) => (ms === null ? null : new Date(ms));

	it("steps an hour field", () => {
		// The screenshot's schedule: minute 17 of every 12th hour.
		expect(at(nextCronFire("17 */12 * * *", from))).toEqual(
			new Date(2026, 8, 23, 12, 17),
		);
	});

	it("steps minutes and handles lists and ranges", () => {
		expect(at(nextCronFire("*/5 * * * *", from))).toEqual(
			new Date(2026, 8, 23, 10, 10),
		);
		expect(at(nextCronFire("0 9-10,14 * * *", from))).toEqual(
			new Date(2026, 8, 23, 14, 0),
		);
	});

	it("matches day-of-week, with 7 as Sunday", () => {
		expect(at(nextCronFire("0 9 * * 7", from))).toEqual(
			new Date(2026, 8, 27, 9, 0),
		);
	});

	it("gives up on garbage and schedules beyond a week", () => {
		expect(nextCronFire("nope", from)).toBeNull();
		expect(nextCronFire("0 0 1 1 *", from)).toBeNull();
	});
});

describe("artifactLink", () => {
	const say = (role: "user" | "assistant", text: string): BriefMessage => ({
		role,
		text,
		at: null,
	});
	it("returns the newest artifact the agent published, not one you pasted", () => {
		expect(
			artifactLink([
				say("user", "update https://claude.ai/artifact/pasted"),
				say("assistant", "Published: https://claude.ai/code/artifact/abc-1."),
				say("assistant", "[Report](https://claude.ai/artifact/def2)"),
			]),
		).toBe("https://claude.ai/artifact/def2");
		expect(artifactLink([say("user", "https://claude.ai/artifact/x")])).toBe(
			null,
		);
		expect(linkKind("https://claude.ai/artifact/x")).toBe("artifact");
		expect(linkLabel("https://claude.ai/code/artifact/x")).toBe("Artifact");
	});
});

describe("actionItems", () => {
	const turn = (text: string) => ({
		role: "assistant" as const,
		text,
		at: null,
	});
	it("lists the newest turn's items", () => {
		expect(
			actionItems([
				turn("ACTION ITEMS\n1. old"),
				turn(
					"Done.\n\n## ACTION ITEMS\n1. Merge #12\n2) Restart Odin dev\n- Check it",
				),
			]),
		).toEqual(["Merge #12", "Restart Odin dev", "Check it"]);
	});
	it("turns a heading's sub-items into items that carry it", () => {
		expect(
			actionItems([
				turn(
					"ACTION ITEMS\n1. **You:** Merge #26\n2. **Still waiting:**\n   - your OK on the PR\n   - your pick\n3. Restart",
				),
			]),
		).toEqual([
			"**You:** Merge #26",
			"**Still waiting:** your OK on the PR",
			"**Still waiting:** your pick",
			"Restart",
		]);
	});
	it("gives nothing for none or a missing section", () => {
		expect(
			actionItems([turn("Done.\n\nACTION ITEMS: none - shipped.")]),
		).toEqual([]);
		expect(
			actionItems([turn("ACTION ITEMS\n1. x"), turn("Just chatting.")]),
		).toEqual([]);
	});
});

describe("onlyMergeLeft", () => {
	const turn = (text: string) => ({
		role: "assistant" as const,
		text,
		at: null,
	});
	it("is true when every item is a merge", () => {
		expect(
			onlyMergeLeft([
				turn(
					"ACTION ITEMS\n1. Merge PR #12\n2. Review and merge #13\n3. Get repo#14 merged so X stops",
				),
			]),
		).toBe(true);
	});
	it("is false with anything else left, or nothing", () => {
		expect(
			onlyMergeLeft([turn("ACTION ITEMS\n1. Merge #12\n2. Restart Odin dev")]),
		).toBe(false);
		expect(onlyMergeLeft([turn("ACTION ITEMS: none")])).toBe(false);
	});
});

describe("onlyLookLeft", () => {
	const turn = (text: string) => ({
		role: "assistant" as const,
		text,
		at: null,
	});
	it("is true when every item is a look at what shipped", () => {
		for (const item of [
			"Reload the Odin window (⌘R) and open the All feed.",
			"Press ⌘R in Odin, then press Keep on a row.",
			"Refresh the Review page and confirm they stay gone.",
			"Open Insights and check the new bar color.",
			"Check that all 10 cards appear under Needs you.",
			'Confirm the "Drop?" rows are gone from Next in line.',
			"Close the open drawer; press ⌘R if Resume still bounces.",
			"Click Resume on a stopped card; confirm the drawer opens.",
			"Send the reply to Gil.",
			"Post the draft in #studio-bug-report.",
			"Paste the reply into the Slack thread.",
		])
			expect(onlyLookLeft([turn(`ACTION ITEMS\n1. ${item}`)])).toBe(true);
	});
	it("is false with anything else left, or nothing", () => {
		for (const item of [
			"Restart Odin dev to load the fix.",
			"Merge #12",
			"Check why the GitHub token returns 401.",
			"Confirm I should fire the 6 DELETEs.",
			"Open Settings → Board and set your session limit.",
			"Confirm the two excluded channels should stay out.",
			"Open the brief and check it reads right?",
			"Send me the failing request ID.",
			"Send the reply to Gil, or should I hold it?",
		])
			expect(
				onlyLookLeft([turn(`ACTION ITEMS\n1. Reload Odin.\n2. ${item}`)]),
			).toBe(false);
		expect(onlyLookLeft([turn("ACTION ITEMS: none")])).toBe(false);
	});
});

describe("ciRunning", () => {
	const pr = (
		state: string,
		pending: string[],
		mine: boolean | null = true,
	) => ({
		state,
		pending,
		mine,
	});

	it("names the checks still running on your open PRs", () => {
		expect(
			ciRunning({
				a: pr("OPEN", ["check", "smoke"]),
				b: pr("OPEN", []),
				c: null,
			}),
		).toEqual(["check", "smoke"]);
	});

	it("ignores a teammate's PR and a closed or merged one", () => {
		expect(
			ciRunning({
				a: pr("OPEN", ["check"], false),
				b: pr("MERGED", ["check"]),
				c: pr("CLOSED", ["check"]),
			}),
		).toEqual([]);
	});

	it("counts a PR whose author is unknown", () => {
		expect(ciRunning({ a: pr("OPEN", ["check"], null) })).toEqual(["check"]);
	});
});

describe("mergeReady", () => {
	const turn = (text: string) => ({
		role: "assistant" as const,
		text,
		at: null,
	});
	const a = "https://github.com/o/r/pull/12";
	const b = "https://github.com/o/r/pull/13";
	const opened = turn(`Opened ${a} and ${b}.`);
	const items = turn("Done.\n\nACTION ITEMS\n1. Merge #12\n2. Merge #13");
	const approved = { state: "OPEN", approved: true };
	it("is true once every PR is approved, merged or closed", () => {
		expect(
			mergeReady([opened, items], {
				[a]: approved,
				[b]: { state: "MERGED" },
			}),
		).toBe(true);
		expect(
			mergeReady([opened, items], { [a]: approved, [b]: { state: "CLOSED" } }),
		).toBe(true);
	});
	it("is true with other items left, as long as the PRs are approved", () => {
		expect(
			mergeReady(
				[opened, turn("ACTION ITEMS\n1. Merge #12\n2. Tell CS\n3. Decide X")],
				{ [a]: approved, [b]: approved },
			),
		).toBe(true);
	});
	it("ignores a teammate's PR the session only linked", () => {
		expect(
			mergeReady([opened, items], {
				[a]: approved,
				[b]: { state: "OPEN", approved: false, mine: false },
			}),
		).toBe(true);
	});
	it("is false while any of them waits on review, is red, or is unknown", () => {
		expect(
			mergeReady([opened, items], {
				[a]: approved,
				[b]: { state: "OPEN", approved: false },
			}),
		).toBe(false);
		expect(
			mergeReady([opened, items], {
				[a]: approved,
				[b]: { ...approved, failed: ["CI"] },
			}),
		).toBe(false);
		expect(mergeReady([opened, items], { [a]: approved, [b]: null })).toBe(
			false,
		);
	});
	it("is false with every PR merged and more than a merge left, or you replied", () => {
		const merged = { state: "MERGED" };
		expect(mergeReady([opened, items], { [a]: merged, [b]: merged })).toBe(
			true,
		);
		expect(
			mergeReady([opened, turn("ACTION ITEMS\n1. Restart Odin dev")], {
				[a]: merged,
				[b]: merged,
			}),
		).toBe(false);
		expect(
			mergeReady(
				[opened, items, { role: "user", text: "merge them", at: null }],
				{ [a]: approved, [b]: approved },
			),
		).toBe(false);
	});
	it("calls a session dropped once a PR closed and none is left open", () => {
		const closed = { state: "CLOSED" };
		const merged = { state: "MERGED" };
		expect(prsDropped([opened, items], { [a]: closed, [b]: closed })).toBe(
			true,
		);
		expect(prsDropped([opened, items], { [a]: closed, [b]: merged })).toBe(
			true,
		);
		expect(prsDropped([opened, items], { [a]: merged, [b]: merged })).toBe(
			false,
		);
		expect(prsDropped([opened, items], { [a]: closed, [b]: approved })).toBe(
			false,
		);
		expect(prsDropped([opened, items], { [a]: closed, [b]: null })).toBe(false);
		expect(
			prsDropped([opened, items], {
				[a]: { state: "CLOSED", mine: false },
				[b]: merged,
			}),
		).toBe(false);
	});
	it("ends a review once the PR under review merges or closes", () => {
		const url = "https://github.com/acme/web/pull/7";
		const brief = `Task\n\nLink: ${url}`;
		const review = [
			{
				role: "user" as const,
				text: `Review this pull request: Fix\n${url}`,
				at: null,
			},
		];
		const reviewed = reviewedPullRequest(brief, review);
		expect(reviewed?.number).toBe(7);
		expect(reviewedPullRequest(brief, [opened])).toBeNull();
		expect(
			reviewEnded(reviewed, { [url]: { state: "MERGED", mine: false } }),
		).toBe("MERGED");
		expect(reviewEnded(reviewed, { [url]: { state: "CLOSED" } })).toBe(
			"CLOSED",
		);
		expect(reviewEnded(reviewed, { [url]: { state: "OPEN" } })).toBeNull();
		expect(reviewEnded(reviewed, {})).toBeNull();
	});
	it("targets the named PRs, else the newest one", () => {
		expect(mergeTargets([opened, items]).map((pr) => pr.number)).toEqual([
			13, 12,
		]);
		expect(
			mergeTargets([opened, turn("ACTION ITEMS\n1. Merge the PR")]).map(
				(pr) => pr.number,
			),
		).toEqual([13]);
	});
});

describe("linkRefs", () => {
	const prs = [
		{
			url: "https://github.com/o/imagen-public-mcp/pull/2",
			repo: "o/imagen-public-mcp",
			number: 2,
		},
		{
			url: "https://github.com/o/terraform/pull/1455",
			repo: "o/terraform",
			number: 1455,
		},
		{ url: "https://github.com/o/k8s/pull/2", repo: "o/k8s", number: 2 },
	];
	const issue = {
		key: "BUGT-3781",
		url: "https://x.atlassian.net/browse/BUGT-3781",
	};
	const links = (text: string) =>
		linkRefs(text, prs, issue)
			.filter((part) => part.url)
			.map(
				(part) => `${part.text} -> ${part.url?.split("/").slice(-3).join("/")}`,
			);

	it("links a repo-named PR whole, and picks that repo's #2", () => {
		expect(links("Merge imagen-public-mcp #2.")).toEqual([
			"imagen-public-mcp #2 -> imagen-public-mcp/pull/2",
		]);
		expect(links("Apply terraform#1455: ecr")).toEqual([
			"terraform#1455 -> terraform/pull/1455",
		]);
		expect(links("k8s #2 first")).toEqual(["k8s #2 -> k8s/pull/2"]);
	});

	it("links only the number after a verb, and only when it's unambiguous", () => {
		expect(links("Merge #1455 now")).toEqual(["#1455 -> terraform/pull/1455"]);
		// Two PRs numbered 2: a bare "#2" could be either.
		expect(links("Merge #2 now")).toEqual([]);
	});

	it("leaves PRs and tickets the session never quoted alone", () => {
		expect(links("See other-repo#1455 and UTF-8 and SHIP-12")).toEqual([]);
		expect(links("Reply on BUGT-3781")).toEqual([
			"BUGT-3781 -> x.atlassian.net/browse/BUGT-3781",
		]);
	});

	it("keeps the prose around the links intact", () => {
		const parts = linkRefs("Merge terraform#1455, then deploy.", prs, null);
		expect(parts.map((part) => part.text).join("")).toBe(
			"Merge terraform#1455, then deploy.",
		);
	});
});

describe("linkContext", () => {
	const say = (text: string): BriefMessage => ({
		role: "assistant",
		text,
		at: null,
	});
	const doc = "https://docs.google.com/spreadsheets/d/1I9T/edit?gid=0#gid=0";

	it("reads the label and the sentence the link sat in", () => {
		expect(
			linkContext(
				[
					say(
						`**The file you asked for.** [Touchpoint requests](${doc}) is in Sources.`,
					),
				],
				doc,
			),
		).toEqual({
			title: "Touchpoint requests",
			summary: "Touchpoint requests is in Sources.",
		});
	});

	it("drops the label off a table row, keeping the cells after it", () => {
		const page = "https://app.notion.com/p/3799a1b573ff81cfacb3fa9191ea2359";
		expect(
			linkContext(
				[say(`| [Sources](${page}) | 16 team-owned artifacts | appended |`)],
				page,
			),
		).toEqual({
			title: "Sources",
			summary: "16 team-owned artifacts · appended",
		});
	});

	it("reads the first mention - the introduction, not the updates after it", () => {
		const art = "https://claude.ai/code/artifact/abc-123";
		expect(
			linkContext(
				[
					say(`Artifact: ${art}`),
					say(`Here's the draft Gantt with the suggested owners: ${art}`),
					say(
						`The legend says "Planned" now. It's live at the same link: ${art}`,
					),
				],
				art,
			),
		).toEqual({
			title: null,
			summary: "Here's the draft Gantt with the suggested owners",
		});
	});

	it("keeps only the sentence the link sits in", () => {
		const page = "https://app.notion.com/p/8a858df8532b40b7a00b2912852932ab";
		expect(
			linkContext(
				[
					say(
						`**It's private.** The real schedule is the Notion Gantt: ${page}`,
					),
				],
				page,
			)?.summary,
		).toBe("The real schedule is the Notion Gantt");
	});

	it("matches a Notion page by id across its url shapes", () => {
		const id = "8a858df8532b40b7a00b2912852932ab";
		expect(
			linkContext(
				[say(`Wrote [Department requests](https://www.notion.so/Dept-${id})`)],
				`https://app.notion.com/p/${id}`,
			)?.title,
		).toBe("Department requests");
	});

	it("is null for a link nobody described", () => {
		expect(linkContext([say(doc)], doc)).toBeNull();
		expect(linkContext([], doc)).toBeNull();
	});
});

describe("postedMessage", () => {
	const url = "https://acme.slack.com/archives/C1/p1791124797945759";
	const prompt = (text: string): BriefMessage => ({
		role: "user",
		text,
		at: null,
	});

	it("reads the message Odin quoted when it launched the session", () => {
		const launch = `Task: Can we have a Gantt\n\nThis task comes from a Slack thread: ${url}\n\nWhat was posted there:\n@channel all V2 initiatives are here.\n\nCan we have a Gantt by EOW?\n\nPHASE 1 - INGEST (do this first):\n- Read it`;
		expect(postedMessage([prompt(launch)], url)).toBe(
			"@channel all V2 initiatives are here.\n\nCan we have a Gantt by EOW?",
		);
	});

	it("is null for another thread, or a launch that quoted nothing", () => {
		const bare = `This task comes from a Slack thread: ${url}\n\nPHASE 1 - INGEST`;
		expect(postedMessage([prompt(bare)], url)).toBeNull();
		expect(postedMessage([prompt(bare)], `${url}9`)).toBeNull();
	});
});

describe("emailLink", () => {
	const gmail = "https://mail.google.com/mail/u/0/#inbox/FMfcgzQ123";
	it("takes the launch row's Gmail link", () => {
		expect(emailLink(`Reply to Asya\n${gmail}`, [])).toBe(gmail);
	});
	it("falls back to the first Gmail link in the conversation", () => {
		expect(
			emailLink("https://acme.atlassian.net/browse/SHIP-1", [
				{ role: "user", text: `see (${gmail}).`, at: null },
			]),
		).toBe(gmail);
		expect(linkKind(gmail)).toBe("email");
	});
	it("is null with no Gmail link", () => {
		expect(emailLink(null, [])).toBeNull();
	});
});
