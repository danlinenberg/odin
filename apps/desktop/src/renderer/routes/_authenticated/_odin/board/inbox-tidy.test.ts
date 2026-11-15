import { describe, expect, it } from "bun:test";
import { tidyText } from "./inbox";

describe("tidyText", () => {
	it("folds a pasted link and its echoes into one short label", () => {
		expect(
			tidyText(
				"github.com/acme/infra/pull/1635 (https://github.com/acme/infra/pull/1635) <https://github.com/acme/infra/pull/1635>",
			),
		).toBe("infra#1635");
	});

	it("drops a cut-off trailing echo", () => {
		expect(
			tidyText(
				"github.com/acme/infra/pull/7 (https://github.com/acme/infra/pull/7) <https://github.com/acme/i",
			),
		).toBe("infra#7");
	});

	it("shortens a URL inside a sentence and keeps its punctuation", () => {
		expect(
			tidyText(
				"Merge it: https://github.com/acme/app/pull/12. Then https://example.com/a/b",
			),
		).toBe("Merge it: app#12. Then example.com/…");
	});

	it("leaves text without links alone", () => {
		expect(tidyText("Merge PR #7407")).toBe("Merge PR #7407");
	});
});
