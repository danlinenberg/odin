/** The Insights numbers a cheer reads: one row per week, oldest first. */
export interface CheerWeek {
	/** Sunday 00:00 local, as an epoch ms. */
	start: number;
	/** Merged PRs that week. */
	shipped: number;
	/** Sessions running at once while any ran. */
	parallel: number | null;
}

/** Sunday 00:00 local - the same week boundary Insights uses. */
export function weekStart(at: number): number {
	const date = new Date(at);
	date.setHours(0, 0, 0, 0);
	date.setDate(date.getDate() - date.getDay());
	return date.getTime();
}

/** A week and a day, so a daylight-saving week still counts as the next one. */
const NEXT_WEEK_MS = 8 * 86_400_000;

/**
 * Huginn's "good job" for last week, or null when last week didn't beat the
 * one before it. Only finished weeks count - a week still going is never
 * held up against a full one.
 */
export function cheerFor(weeks: CheerWeek[], now: number): string | null {
	const done = weeks.filter((week) => week.start < weekStart(now));
	const last = done.at(-1);
	const before = done.at(-2);
	if (!last || !before) return null;
	// Last week must be the one just ended, and follow its rival directly.
	if (weekStart(now) - last.start > NEXT_WEEK_MS) return null;
	if (last.start - before.start > NEXT_WEEK_MS) return null;
	if (last.shipped > before.shipped && before.shipped > 0) {
		const up = Math.round((last.shipped / before.shipped - 1) * 100);
		return `You merged ${last.shipped} PRs last week, ${up}% more than the week before. Good job.`;
	}
	if (last.shipped > before.shipped && last.shipped >= 2)
		return `You merged ${last.shipped} PRs last week, up from ${before.shipped}. Nice work.`;
	const was = before.parallel ?? 0;
	const now_ = last.parallel ?? 0;
	if (was > 0 && now_ >= was * 1.2 && now_ >= 1.5)
		return `You ran ${now_.toFixed(1)} agents at once on average last week, up from ${was.toFixed(1)}. You're getting the hang of this.`;
	return null;
}
