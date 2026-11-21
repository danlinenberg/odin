import { describe, expect, test } from "bun:test";
import {
	changeSetting,
	type HuginnSetting,
	listSettings,
	parseValue,
	type SettingsContext,
} from "./crow-settings-core";

function setup(answer = true) {
	const values: Record<string, unknown> = {
		"Open links inside Odin": false,
		"Close idle sessions after": 3,
		Theme: "Odin Dark",
		"Notify at": "09:00",
		"Let sessions send Slack messages": false,
		"Merge pull requests": false,
	};
	const asked: string[] = [];
	const announced: string[] = [];
	const setting = (
		label: string,
		kind: HuginnSetting["kind"],
		extra: Partial<HuginnSetting> = {},
	): HuginnSetting => ({
		label,
		kind,
		read: () => values[label],
		write: (value) => {
			values[label] = value;
		},
		...extra,
	});
	const ctx: SettingsContext = {
		settings: [
			setting("Open links inside Odin", { type: "switch" }),
			setting("Close idle sessions after", {
				type: "number",
				min: 0,
				max: 168,
				step: 0.5,
				unit: "hours",
			}),
			setting("Theme", {
				type: "choice",
				choices: () => ["Odin Dark", "Light"],
			}),
			setting("Notify at", { type: "time" }),
			setting(
				"Let sessions send Slack messages",
				{ type: "switch" },
				{ asksFirst: true },
			),
			setting(
				"Merge pull requests",
				{ type: "switch" },
				{ asksFirst: true, shown: () => false },
			),
		],
		whereIs: (label) => `Settings → Screen › ${label.split(" ")[0]}`,
		confirm: async (question) => {
			asked.push(question);
			return answer;
		},
		announce: (text) => announced.push(text),
	};
	return { ctx, values, asked, announced };
}

describe("parseValue", () => {
	test("a switch takes on/off words", () => {
		expect(parseValue({ type: "switch" }, "On")).toEqual({ value: true });
		expect(parseValue({ type: "switch" }, "false")).toEqual({ value: false });
		expect(parseValue({ type: "switch" }, "maybe")).toHaveProperty("error");
	});

	test("a number snaps to its step and refuses one out of range", () => {
		const kind = {
			type: "number" as const,
			min: 0,
			max: 168,
			step: 0.5,
			unit: "hours",
		};
		expect(parseValue(kind, "6.3 hours")).toEqual({ value: 6.5 });
		expect(parseValue(kind, "200")).toEqual({
			error: "It goes from 0 to 168 hours.",
		});
		expect(parseValue(kind, "soon")).toHaveProperty("error");
	});

	test("a time is HH:MM and a choice matches any case", () => {
		expect(parseValue({ type: "time" }, "8:30")).toEqual({ value: "08:30" });
		expect(parseValue({ type: "time" }, "25:00")).toHaveProperty("error");
		const kind = { type: "choice" as const, choices: () => ["Light", "Dark"] };
		expect(parseValue(kind, "light")).toEqual({ value: "Light" });
		expect(parseValue(kind, "Blue")).toEqual({
			error: "Pick one of: Light, Dark.",
		});
	});
});

describe("changeSetting", () => {
	test("changes a setting by its label and says what changed", async () => {
		const { ctx, values, announced } = setup();
		const reply = await changeSetting(ctx, {
			name: "open links inside odin",
			value: "on",
		});
		expect(values["Open links inside Odin"]).toBe(true);
		expect(reply).toBe(
			"Changed Open links inside Odin (Settings → Screen › Open) from off to on. It applies now.",
		);
		expect(announced).toEqual([
			"Huginn changed Open links inside Odin: off → on",
		]);
	});

	test("a few words of the label are enough when only one fits", async () => {
		const { ctx, values } = setup();
		await changeSetting(ctx, { name: "idle sessions", value: "6" });
		expect(values["Close idle sessions after"]).toBe(6);
	});

	test("an unchanged value writes nothing", async () => {
		const { ctx, announced } = setup();
		expect(
			await changeSetting(ctx, { name: "Theme", value: "odin dark" }),
		).toBe("Theme (Settings → Screen › Theme) is already Odin Dark.");
		expect(announced).toEqual([]);
	});

	test("a setting not on the list is the user's to change", async () => {
		const { ctx } = setup();
		expect(
			await changeSetting(ctx, { name: "Slack sign-in", value: "off" }),
		).toStartWith('No setting I can change is called "Slack sign-in"');
	});

	test("one that loosens what sessions may do asks first, and no keeps it", async () => {
		const { ctx, values, asked } = setup(false);
		const reply = await changeSetting(ctx, {
			name: "Let sessions send Slack messages",
			value: "on",
		});
		expect(asked).toHaveLength(1);
		expect(values["Let sessions send Slack messages"]).toBe(false);
		expect(reply).toContain("The user said no in Odin");
	});

	test("yes in the window lets it through; turning it off never asks", async () => {
		const { ctx, values, asked } = setup(true);
		await changeSetting(ctx, {
			name: "Let sessions send Slack messages",
			value: "on",
		});
		expect(values["Let sessions send Slack messages"]).toBe(true);
		await changeSetting(ctx, {
			name: "Let sessions send Slack messages",
			value: "off",
		});
		expect(asked).toHaveLength(1);
		expect(values["Let sessions send Slack messages"]).toBe(false);
	});

	test("a setting whose row is hidden can't be changed", async () => {
		const { ctx, values } = setup();
		await changeSetting(ctx, { name: "Merge pull requests", value: "on" });
		expect(values["Merge pull requests"]).toBe(false);
	});
});

test("listSettings shows place, value, what it takes and which ask first", async () => {
	const { ctx } = setup();
	const list = await listSettings(ctx);
	expect(list).toContain(
		"Close idle sessions after (Settings → Screen › Close): 3 hours [0-168 hours]",
	);
	expect(list).toContain(
		"Let sessions send Slack messages (Settings → Screen › Let): off [on/off] - asks the user in Odin before turning on",
	);
	expect(list).not.toContain("Merge pull requests");
	expect(await listSettings(ctx, "theme")).toStartWith(
		"Theme (Settings → Screen › Theme): Odin Dark [Odin Dark | Light]",
	);
});
