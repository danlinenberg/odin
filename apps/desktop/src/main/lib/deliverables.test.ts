import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyPrompt,
	deliveredPerWeek,
	judgeInBackground,
	parseClassification,
	parseSuggestions,
	readKinds,
	type SessionForVerdict,
	writeKinds,
} from "./deliverables";

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const NOW = Date.UTC(2026, 10, 20, 12);
const WEEK1 = NOW - 2 * WEEK;
const WEEK2 = NOW - WEEK;

const session = (
	sessionId: string,
	title: string,
	endedAt: number,
	description: string | null = null,
): SessionForVerdict => ({ sessionId, title, description, endedAt });

const storePath = () =>
	join(mkdtempSync(join(tmpdir(), "deliverables-")), "deliverables.json");

const KINDS = [
	{ id: "email", name: "Emails sent live", description: "a campaign set live" },
	{
		id: "asset",
		name: "Assets placed",
		description: "an image put in the app",
	},
];

describe("parseClassification", () => {
	test("reads kind ids per session and drops unknown ones", () => {
		const reply =
			"S1: email\nS2: none\n**S3**: asset, email, banner\nnoise\nS9: email";
		expect(parseClassification(reply, 3, KINDS)).toEqual([
			["email"],
			[],
			["asset", "email"],
		]);
	});

	test("a session the model skipped delivered nothing", () => {
		expect(parseClassification("S2: asset", 2, KINDS)).toEqual([[], ["asset"]]);
	});
});

test("classifyPrompt lists the kinds and one line per session", () => {
	const prompt = classifyPrompt(
		[session("a", "Spring sale email", WEEK1, "Set the campaign live")],
		KINDS,
	);
	expect(prompt).toContain("- email: Emails sent live - a campaign set live");
	expect(prompt).toContain("S1: Spring sale email | Set the campaign live");
});

test("parseSuggestions takes name | description lines", () => {
	expect(
		parseSuggestions(
			"1. Emails sent live | A campaign set live in the email tool\nnot a kind\n- Assets placed | An image put in the app",
		),
	).toEqual([
		{
			name: "Emails sent live",
			description: "A campaign set live in the email tool",
		},
		{ name: "Assets placed", description: "An image put in the app" },
	]);
});

describe("deliveredPerWeek", () => {
	test("nothing to count and no model call until you name a kind", async () => {
		const path = storePath();
		let calls = 0;
		const out = await deliveredPerWeek([WEEK1], [session("a", "x", WEEK1)], {
			path,
			now: NOW,
			model: async () => {
				calls++;
				return "";
			},
		});
		expect(out).toEqual({ kinds: [], weeks: [], judging: 0 });
		expect(calls).toBe(0);
	});

	test("judges settled sessions once, counts them by the week they ended", async () => {
		const path = storePath();
		await writeKinds(KINDS, path);
		const kinds = await readKinds(path);
		expect(kinds.map((k) => k.id)).toEqual(["email", "asset"]);
		const sessions = [
			session("a", "Spring sale email", WEEK1 + HOUR),
			session("b", "Hero image", WEEK2 + HOUR),
			session("c", "Bug hunt", WEEK2 + 2 * HOUR),
			// Still going: not judged yet.
			session("d", "Draft newsletter", NOW - 5 * 60_000),
		];
		const prompts: string[] = [];
		const model = async (prompt: string) => {
			prompts.push(prompt);
			return "S1: none\nS2: asset, email\nS3: email";
		};
		const first = await deliveredPerWeek([WEEK1, WEEK2], sessions, {
			path,
			now: NOW,
			model,
		});
		expect(first.judging).toBe(3);
		await judgeInBackground(sessions, { path, now: NOW, model });
		// Newest first: c, b, a.
		expect(prompts).toHaveLength(1);
		const second = await deliveredPerWeek([WEEK1, WEEK2], sessions, {
			path,
			now: NOW,
			model,
		});
		expect(second.judging).toBe(0);
		expect(second.weeks).toEqual([
			{ start: WEEK1, counts: { email: 1, asset: 0 } },
			{ start: WEEK2, counts: { email: 1, asset: 1 } },
		]);
		// Cached: no second call for the same briefs and kinds.
		await judgeInBackground(sessions, { path, now: NOW, model });
		expect(prompts).toHaveLength(1);
	});

	test("changing a kind's description asks again", async () => {
		const path = storePath();
		await writeKinds(KINDS, path);
		const sessions = [session("a", "Spring sale email", WEEK1)];
		let calls = 0;
		const model = async () => {
			calls++;
			return "S1: email";
		};
		await judgeInBackground(sessions, { path, now: NOW, model });
		const kinds = await readKinds(path);
		await writeKinds(
			kinds.map((k) =>
				k.id === "email" ? { ...k, description: "sent to customers" } : k,
			),
			path,
		);
		await judgeInBackground(sessions, { path, now: NOW, model });
		expect(calls).toBe(2);
	});
});
