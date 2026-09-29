import { describe, expect, it } from "bun:test";
import { parseGmailAtom } from "./index";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed version="0.3" xmlns="http://purl.org/atom/ns#">
<title>Gmail - Inbox for me@example.com</title>
<fullcount>2</fullcount>
<entry>
<title>Q3 &amp; Q4 &quot;plan&quot;</title>
<summary>Can you look at this by Friday?</summary>
<link rel="alternate" href="https://mail.google.com/mail?account_id=me@example.com&amp;message_id=abc&amp;view=conv&amp;extsrc=atom" type="text/html" />
<modified>2026-09-29T10:00:00Z</modified>
<issued>2026-09-29T09:59:00Z</issued>
<id>tag:gmail.google.com,2004:111</id>
<author><name>Ann Lee</name><email>ann@example.com</email></author>
</entry>
<entry>
<title></title>
<summary></summary>
<link rel="alternate" href="https://mail.google.com/x" type="text/html" />
<modified>2026-09-28T10:00:00Z</modified>
<id>tag:gmail.google.com,2004:222</id>
<author><name></name><email>bot@example.com</email></author>
</entry>
</feed>`;

describe("parseGmailAtom", () => {
	it("reads every entry, unescaped, with the fallbacks", () => {
		expect(parseGmailAtom(FEED)).toEqual([
			{
				id: "tag:gmail.google.com,2004:111",
				url: "https://mail.google.com/mail?account_id=me@example.com&message_id=abc&view=conv&extsrc=atom",
				subject: 'Q3 & Q4 "plan"',
				snippet: "Can you look at this by Friday?",
				from: "Ann Lee",
				at: "2026-09-29T09:59:00Z",
			},
			{
				id: "tag:gmail.google.com,2004:222",
				url: "https://mail.google.com/x",
				subject: "(no subject)",
				snippet: "",
				from: "bot@example.com",
				at: "2026-09-28T10:00:00Z",
			},
		]);
	});

	it("an empty inbox is no rows", () => {
		expect(parseGmailAtom("<feed><fullcount>0</fullcount></feed>")).toEqual([]);
	});
});
