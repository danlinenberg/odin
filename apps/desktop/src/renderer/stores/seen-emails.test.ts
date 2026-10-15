import { expect, test } from "bun:test";
import { rememberEmails, withSeenEmails } from "./seen-emails";

const mail = (id: string, at: string) => ({
	id,
	url: `u/${id}`,
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
		withSeenEmails([mail("b", "2026-01-01")], seen).map((e) => e.id),
	).toEqual(["a", "b"]);
	expect(rememberEmails(seen, [], 31 * 86_400_000)).toEqual({});
});

test("a remembered calendar mail is junk, whatever its old verdict", () => {
	const invite = {
		...mail("Accepted: Dan/Ayelet @ Sun", "2026-01-01"),
		junk: false,
	};
	const seen = rememberEmails({}, [invite], 0);
	expect(withSeenEmails([], seen)[0]?.junk).toBe(true);
});
