import { describe, expect, test } from "bun:test";
import {
	draftLanguage,
	messageLanguage,
	messageLanguages,
} from "./message-languages";

describe("messageLanguages", () => {
	test("tells the language by its script", () => {
		expect(messageLanguage("can you approve this?")).toBe("English");
		expect(messageLanguage("שלחי לי את הרשימה")).toBe("Hebrew");
		expect(messageLanguage("עדכנתי את הapi")).toBe("Hebrew");
	});

	test("keeps languages I write in often, most used first", () => {
		const messages = [
			...Array(6).fill("שלחי לי"),
			...Array(10).fill("sounds good?"),
			"Привет",
		];
		expect(messageLanguages(messages)).toEqual(["English", "Hebrew"]);
	});

	test("English alone when nothing else is used", () => {
		expect(messageLanguages([])).toEqual(["English"]);
	});
});

describe("draftLanguage", () => {
	test("a Hebrew draft with code blocks and tech terms is Hebrew", () => {
		const draft = [
			"היי, הסקריפט רץ כל לילה בcron, תוסיף את זה:",
			"```",
			"xvfb-run --auto-servernum pnpm run dev:production --headless --port 9222",
			"```",
			"ואז תריץ `electron-run stop` ותבדוק ב https://github.com/imagenai/submitter-app-electron/pull/1234",
		].join("\n");
		expect(draftLanguage(draft)).toBe("Hebrew");
	});

	test("an English draft is English, even with a Hebrew word in it", () => {
		expect(
			draftLanguage("Workaround for now - restart the app, it reads שלום fine"),
		).toBe("English");
	});
});
