import { expect, test } from "bun:test";
import { newestTagFromFeed, tagFromLocation } from "./release-tags";

test("tagFromLocation reads the tag /releases/latest redirects to", () => {
	expect(
		tagFromLocation(
			"https://github.com/danlinenberg/odin/releases/tag/v1.0.22",
		),
	).toBe("v1.0.22");
	expect(tagFromLocation("https://github.com/danlinenberg/odin/releases")).toBe(
		null,
	);
	expect(tagFromLocation(null)).toBe(null);
});

test("newestTagFromFeed reads the first entry, not the feed's own links", () => {
	const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/danlinenberg/odin/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/danlinenberg/odin/releases"/>
  <link type="application/atom+xml" rel="self" href="https://github.com/danlinenberg/odin/releases.atom"/>
  <entry>
    <id>tag:github.com,2008:Repository/1369814971/v1.0.23</id>
    <link rel="alternate" type="text/html" href="https://github.com/danlinenberg/odin/releases/tag/v1.0.23"/>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1369814971/v1.0.22</id>
    <link rel="alternate" type="text/html" href="https://github.com/danlinenberg/odin/releases/tag/v1.0.22"/>
  </entry>
</feed>`;
	expect(newestTagFromFeed(feed)).toBe("v1.0.23");
	expect(newestTagFromFeed("<feed></feed>")).toBe(null);
});
