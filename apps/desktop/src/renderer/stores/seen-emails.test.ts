import { expect, test } from "bun:test";
import { rememberEmails, withSeenEmails } from "./seen-emails";

const mail = (id: string, at: string) => ({
	id,
	url: `https://mail.google.com/mail/u/me@example.com/#all/${id}`,
	subject: id,
	snippet: "",
	from: null,
	fromEmail: null,
	at,
});

test("an opened (now read) mail stays until Done or a month passes", () => {
	const seen = rememberEmails(
		{},
		[mail("a", "2026-01-02"), mail("b", "2026-01-01")],
		0,
	);
	// Next poll: "a" was opened in Gmail, so the unread feed no longer has it.
	expect(
		withSeenEmails([mail("b", "2026-01-01")], seen, "me@example.com").map((e) => e.id),
	).toEqual(["a", "b"]);
	expect(rememberEmails(seen, [], 31 * 86_400_000)).toEqual({});
});

test("a remembered calendar mail is junk, whatever its old verdict", () => {
	const invite = {
		...mail("Accepted: Dan/Ayelet @ Sun", "2026-01-01"),
		junk: false,
	};
	const seen = rememberEmails({}, [invite], 0);
	expect(withSeenEmails([], seen, "me@example.com")[0]?.junk).toBe(true);
});

test("a mail remembered in another profile's Gmail stays out", () => {
	const seen = rememberEmails({}, [mail("private", "2026-01-01")], 0);
	expect(withSeenEmails([], seen, "Me@Example.com")).toHaveLength(1);
	expect(withSeenEmails([], seen, "work@example.com")).toEqual([]);
	expect(withSeenEmails([], seen, null)).toEqual([]);
});
