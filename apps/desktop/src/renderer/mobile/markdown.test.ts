import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { draftText } from "./markdown";

const fence = (language: string | undefined, text: string) =>
	createElement(
		"code",
		language ? { className: `language-${language}` } : {},
		`${text}\n`,
	);

describe("draftText", () => {
	test("a text fence is a draft", () => {
		expect(draftText(fence("text", "Anyone running this?"))).toBe(
			"Anyone running this?",
		);
	});

	test("a labelled code fence is not", () => {
		expect(draftText(fence("bash", "ls -la"))).toBeNull();
	});

	test("an unlabelled fence is a draft only when it reads as prose", () => {
		expect(draftText(fence(undefined, "היי, מצאתי את זה"))).toBe(
			"היי, מצאתי את זה",
		);
		expect(draftText(fence(undefined, "git status -sb"))).toBeNull();
	});
});
