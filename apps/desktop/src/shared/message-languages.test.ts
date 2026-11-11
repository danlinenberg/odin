import { describe, expect, test } from "bun:test";
import { messageLanguage, messageLanguages } from "./message-languages";

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
