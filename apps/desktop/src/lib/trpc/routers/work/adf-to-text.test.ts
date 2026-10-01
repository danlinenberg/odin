import { expect, it } from "bun:test";
import { adfToText } from ".";

const doc = {
	type: "doc",
	content: [
		{ type: "heading", content: [{ type: "text", text: "Steps" }] },
		{
			type: "bulletList",
			content: [
				{
					type: "listItem",
					content: [{ type: "text", text: "open project" }],
				},
			],
		},
		{ type: "paragraph", content: [{ type: "text", text: "then export" }] },
	],
};

it("keeps lines for a description, collapses them for a feed line", () => {
	expect(adfToText(doc, "\n")).toBe("Steps\nopen project\nthen export\n");
	expect(adfToText(doc)).toBe("Stepsopen projectthen export ");
});
