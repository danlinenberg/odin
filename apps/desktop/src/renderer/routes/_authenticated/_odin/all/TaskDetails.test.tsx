import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Linked } from "./TaskDetails";

describe("Linked", () => {
	it("links bare URLs and leaves trailing punctuation outside", () => {
		const html = renderToStaticMarkup(
			<Linked text="See https://github.com/a/b/pull/1, then (https://x.io/y)." />,
		);
		expect(html).toContain('href="https://github.com/a/b/pull/1"');
		expect(html).toContain('href="https://x.io/y"');
		expect(html).toContain("</a>, then (");
	});
});
