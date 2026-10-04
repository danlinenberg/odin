import { describe, expect, it } from "bun:test";
import { opensInOdin } from "./in-odin-links";

describe("opensInOdin", () => {
	it("keeps the task sources' links in Odin", () => {
		for (const url of [
			"https://imagenai.slack.com/archives/C03E00FMZT4/p1789567345867699",
			"https://app.slack.com/client/T01VC5US6L8/C03E00FMZT4",
			"https://imagenai.atlassian.net/browse/BUGT-1",
			"https://github.com/danlinenberg/odin/pull/595",
			"https://www.notion.so/imagen/Page-abc123",
			"https://mail.google.com/mail/u/0/#inbox/abc",
			"https://docs.google.com/document/d/abc/edit",
		]) {
			expect(opensInOdin(url)).toBe(true);
		}
	});

	it("sends everything else to your browser", () => {
		for (const url of [
			"https://www.google.com/search?q=odin",
			"https://drive.google.com/file/d/abc",
			"http://localhost:5173",
			"https://evilgithub.com/x",
			"https://github.com.evil.io/x",
			"mailto:dan@example.com",
			"not a url",
		]) {
			expect(opensInOdin(url)).toBe(false);
		}
	});
});
