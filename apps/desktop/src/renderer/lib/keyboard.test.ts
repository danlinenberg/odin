import { afterEach, describe, expect, it } from "bun:test";
import { canClaimKeyboard, isTypingElsewhere } from "./keyboard";

/** No DOM in bun:test - the predicate reads four properties, so a stand-in
    carrying those four exercises every branch. */
const element = (
	tagName: string,
	className = "",
	isContentEditable = false,
	inMenu = false,
) =>
	({
		tagName,
		isContentEditable,
		classList: { contains: (name: string) => className === name },
		closest: () => (inMenu ? {} : null),
	}) as unknown as Element;

describe("isTypingElsewhere", () => {
	it("yields to a field the user is typing in", () => {
		expect(isTypingElsewhere(element("INPUT"))).toBe(true);
		expect(isTypingElsewhere(element("TEXTAREA"))).toBe(true);
		expect(isTypingElsewhere(element("SELECT"))).toBe(true);
		expect(isTypingElsewhere(element("DIV", "", true))).toBe(true);
	});

	it("yields to an open menu, which holds focus on a plain div", () => {
		expect(isTypingElsewhere(element("DIV", "", false, true))).toBe(true);
	});

	it("does not count the terminal's own input or an idle page", () => {
		expect(
			isTypingElsewhere(element("TEXTAREA", "xterm-helper-textarea")),
		).toBe(false);
		expect(isTypingElsewhere(element("BODY"))).toBe(false);
		expect(isTypingElsewhere(null)).toBe(false);
	});
});

describe("canClaimKeyboard", () => {
	const realDocument = globalThis.document;
	afterEach(() => {
		globalThis.document = realDocument;
	});
	const withDocument = (activeElement: Element | null, modalOpen: boolean) => {
		globalThis.document = {
			activeElement,
			querySelector: () => (modalOpen ? {} : null),
		} as unknown as Document;
	};

	it("claims an idle page", () => {
		withDocument(element("BODY"), false);
		expect(canClaimKeyboard()).toBe(true);
	});

	it("leaves the keyboard alone while a modal is open, even with focus on body", () => {
		withDocument(element("BODY"), true);
		expect(canClaimKeyboard()).toBe(false);
	});
});
