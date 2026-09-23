import { describe, expect, it } from "bun:test";
import {
	type BriefMessage,
	elapsedLabel,
	jiraIssue,
	lastMessageAt,
	notionPage,
	projectSlug,
	pullRequests,
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

const REPORT = `Fixed the drawer focus race — ${"x".repeat(80)}`;

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
				// jump the queue — it was still opened first.
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
	it("keeps one page, the one whose slug names it", () => {
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
