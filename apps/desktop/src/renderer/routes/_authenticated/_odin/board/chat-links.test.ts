import { describe, expect, it } from "bun:test";
import { withSchemes } from "./chat-links";

describe("withSchemes", () => {
	it("links a bare host with a path", () => {
		expect(withSchemes("Published (claude.ai/artifact/KuV95PZ) today.")).toBe(
			"Published (https://claude.ai/artifact/KuV95PZ) today.",
		);
	});

	it("leaves file paths, full URLs, links and code alone", () => {
		const text =
			"Edited src/utils/a.ts and docs/x.md; see https://github.com/o/r/pull/1, [pr](github.com/o/r) and `api.imagen-ai.com/v1`.";
		expect(withSchemes(text)).toBe(text);
	});
});
