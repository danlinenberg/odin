/** Which Notion comment threads are waiting on me — pure, so it's testable. */

export interface NotionComment {
	id: string;
	discussion_id: string;
	created_time: string;
	created_by: { id: string };
	rich_text: {
		plain_text?: string;
		type?: string;
		mention?: { type?: string; user?: { id?: string } };
	}[];
}

export interface MentionThread {
	discussionId: string;
	/** The comment that tagged me. */
	comment: NotionComment;
	/** Newest comment in the thread. */
	latestAt: string;
}

/** Names of the people properties (Assignee, Owner, …) that list me. */
export function propsNamingMe(
	properties: Record<string, { type?: string; people?: { id?: string }[] }>,
	meId: string,
): string[] {
	return Object.entries(properties)
		.filter(
			([, value]) =>
				value.type === "people" &&
				(value.people ?? []).some((person) => person.id === meId),
		)
		.map(([name]) => name);
}

const mentions = (comment: NotionComment, meId: string) =>
	comment.rich_text.some(
		(part) =>
			part.type === "mention" &&
			part.mention?.type === "user" &&
			part.mention.user?.id === meId,
	);

/**
 * Threads where someone @-mentioned me and I haven't replied since — once my
 * reply is the newest comment, the thread is off my plate.
 */
export function openMentionThreads(
	comments: NotionComment[],
	meId: string,
): MentionThread[] {
	const byThread = new Map<string, NotionComment[]>();
	for (const comment of comments) {
		const thread = byThread.get(comment.discussion_id) ?? [];
		thread.push(comment);
		byThread.set(comment.discussion_id, thread);
	}
	const open: MentionThread[] = [];
	for (const [discussionId, thread] of byThread) {
		thread.sort((a, b) => a.created_time.localeCompare(b.created_time));
		const tagged = thread.findLast((c) => mentions(c, meId));
		const latest = thread[thread.length - 1];
		if (!tagged || latest.created_by.id === meId) continue;
		open.push({ discussionId, comment: tagged, latestAt: latest.created_time });
	}
	return open;
}
