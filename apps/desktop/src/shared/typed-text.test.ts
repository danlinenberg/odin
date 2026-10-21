import { describe, expect, test } from "bun:test";
import { typedText } from "./typed-text";

describe("typedText", () => {
	test("types one-line text as keys", () => {
		expect(typedText("why?")).toBe("why?");
	});

	test("pastes multi-line text so its newlines don't send", () => {
		expect(typedText("a\nb")).toBe("\x1b[200~a\nb\x1b[201~");
	});

	test("pastes a lone ? - typed on an empty box it toggles Claude's shortcuts instead", () => {
		expect(typedText("?")).toBe("\x1b[200~?\x1b[201~");
	});
});
