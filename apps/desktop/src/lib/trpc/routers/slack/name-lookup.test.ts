import { describe, expect, it, test } from "bun:test";
import { createNameLookup, sentToBot, slackUserName } from "./name-lookup";

describe("createNameLookup", () => {
	it("asks Slack once for a name, then answers from the cache", async () => {
		const names = createNameLookup();
		let asked = 0;
		const ask = async () => {
			asked++;
			return "Dan";
		};
		expect(await names.get("U1", ask)).toBe("Dan");
		expect(await names.get("U1", ask)).toBe("Dan");
		expect(asked).toBe(1);
	});

	it("keeps a miss for ten minutes instead of asking on every poll", async () => {
		let clock = 0;
		const names = createNameLookup(() => clock);
		let asked = 0;
		const refused = async () => {
			asked++;
			throw new Error("Slack conversations.info: channel_not_found");
		};
		expect(await names.get("C1", refused)).toBeNull();
		clock = 9 * 60_000;
		expect(await names.get("C1", refused)).toBeNull();
		expect(asked).toBe(1);
		clock = 11 * 60_000;
		await names.get("C1", refused);
		expect(asked).toBe(2);
	});

	it("shares a lookup still on the wire", async () => {
		const names = createNameLookup();
		let asked = 0;
		let answer: (name: string) => void = () => {};
		const ask = () => {
			asked++;
			return new Promise<string>((done) => {
				answer = done;
			});
		};
		const first = names.get("U1", ask);
		const second = names.get("U1", ask);
		answer("Dan");
		expect(await Promise.all([first, second])).toEqual(["Dan", "Dan"]);
		expect(asked).toBe(1);
	});
});

describe("slackUserName", () => {
	it("is the display name an @mention shows, not the full name", () => {
		expect(
			slackUserName({
				name: "ana.lopez",
				real_name: "Ana Maria Lopez",
				profile: { display_name: "Ana Lopez", real_name: "Ana Maria Lopez" },
			}),
		).toBe("Ana Lopez");
	});

	it("falls back to the full name when no display name is set", () => {
		expect(
			slackUserName({
				name: "dan",
				real_name: "Dan Linenberg",
				profile: { display_name: "" },
			}),
		).toBe("Dan Linenberg");
	});

	it("is null for an unknown user", () => {
		expect(slackUserName(undefined)).toBeNull();
	});
});

describe("sentToBot", () => {
	const isBot = async (id: string) => id === "UBOT1";

	test("a mention of a bot, or a DM with one, is to a bot", async () => {
		expect(await sentToBot({ text: "<@UBOT1> delete" }, isBot)).toBe(true);
		expect(await sentToBot({ text: "<@UBOT1|helper> delete" }, isBot)).toBe(
			true,
		);
		expect(
			await sentToBot({ text: "every day", channel: { user: "UBOT1" } }, isBot),
		).toBe(true);
		expect(
			await sentToBot(
				{ text: "every day", channel: { is_im: true, name: "UBOT1" } },
				isBot,
			),
		).toBe(true);
	});

	test("a message to people is not", async () => {
		expect(await sentToBot({ text: "<@U0123> can you take it?" }, isBot)).toBe(
			false,
		);
		expect(
			await sentToBot(
				{ text: "on it", channel: { is_im: true, name: "U0123" } },
				isBot,
			),
		).toBe(false);
		// A channel that happens to be named like a bot's id is not a DM.
		expect(
			await sentToBot({ text: "on it", channel: { name: "UBOT1" } }, isBot),
		).toBe(false);
	});
});
