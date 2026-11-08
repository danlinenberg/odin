import { describe, expect, it } from "bun:test";
import { isPromptAttachable } from "./OdinPromptDialog";

const file = (name: string, type = "") => new File(["x"], name, { type });

describe("isPromptAttachable", () => {
	it("takes .md and .txt docs, typed or not", () => {
		expect(isPromptAttachable(file("notes.md"))).toBe(true);
		expect(isPromptAttachable(file("notes.md", "text/markdown"))).toBe(true);
		expect(isPromptAttachable(file("README.MARKDOWN"))).toBe(true);
		expect(isPromptAttachable(file("log.txt", "text/plain"))).toBe(true);
		expect(isPromptAttachable(file("pasted", "text/plain"))).toBe(true);
	});

	it("still takes images, video and PDFs", () => {
		expect(isPromptAttachable(file("a.png", "image/png"))).toBe(true);
		expect(isPromptAttachable(file("a.mov", "video/quicktime"))).toBe(true);
		expect(isPromptAttachable(file("a.pdf"))).toBe(true);
	});

	it("leaves out other files", () => {
		expect(isPromptAttachable(file("a.zip", "application/zip"))).toBe(false);
		expect(isPromptAttachable(file("a.json", "application/json"))).toBe(false);
	});
});
