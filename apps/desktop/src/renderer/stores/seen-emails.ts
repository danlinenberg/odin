import type { EmailRow } from "lib/trpc/routers/work";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** A mail nobody pressed Done on in a month isn't waiting on anyone. */
const KEEP_MS = 30 * 86_400_000;

type SeenEmail = EmailRow & { seenAt: number };

/**
 * Every email the feed has shown. Gmail's feed is unread-only, so opening a
 * mail drops it from the next poll - but Done is the one way a row leaves a
 * feed, so the rows stay here until Done (or KEEP_MS) takes them.
 */
export const useSeenEmails = create<{
	seen: Record<string, SeenEmail>;
	remember: (emails: EmailRow[]) => void;
}>()(
	persist(
		(set) => ({
			seen: {},
			remember: (emails) =>
				set((state) => ({ seen: rememberEmails(state.seen, emails) })),
		}),
		{ name: "odin-seen-emails" },
	),
);

export function rememberEmails(
	seen: Record<string, SeenEmail>,
	emails: EmailRow[],
	now = Date.now(),
): Record<string, SeenEmail> {
	const next = Object.fromEntries(
		Object.entries(seen).filter(([, email]) => now - email.seenAt < KEEP_MS),
	);
	for (const email of emails)
		next[email.id] = { ...email, seenAt: next[email.id]?.seenAt ?? now };
	return next;
}

/** The live feed, plus what it showed before and has since dropped, newest first. */
export function withSeenEmails(
	live: EmailRow[],
	seen: Record<string, SeenEmail>,
): EmailRow[] {
	const ids = new Set(live.map((email) => email.id));
	const gone = Object.values(seen)
		.filter((email) => !ids.has(email.id))
		.map(({ seenAt: _, ...email }) => email);
	return [...live, ...gone].sort((a, b) =>
		(b.at ?? "").localeCompare(a.at ?? ""),
	);
}
