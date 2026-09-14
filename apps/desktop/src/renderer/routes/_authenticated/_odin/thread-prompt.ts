import { BRIEF_DIR } from "@odin/shared/constants";

function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "task"
	);
}

/**
 * The prompt every Slack-sourced session starts from — shared by the Slack
 * Queue (Notion rows) and the Reactions feed, so both ingest a thread the
 * same way.
 */
export function buildThreadPrompt(
	slackUrl: string,
	title: string,
	/** The reacted message itself. See why it's quoted, below. */
	text?: string,
): string {
	// Per-task brief path so concurrent sessions in the same workspace never
	// clobber each other's digest (the old shared TASK_BRIEF.md did).
	const briefPath = `${BRIEF_DIR}/brief-${slugify(title)}.md`;
	const posted = text?.trim();
	return [
		// The URL stays the first line: the board finds a session's thread by the
		// first Slack link in its transcript, and a pasted link inside the message
		// would otherwise win (see brief.ts slackThread).
		`This task comes from a Slack thread: ${slackUrl}`,
		"",
		// The message itself, quoted — without it the opening prompt is pure Odin
		// plumbing, so Claude's generated title comes out as "Ingest and execute
		// Slack thread task" and Session History has nothing of the real ask to
		// search. `title` is only the message's first line, which is routinely a
		// greeting.
		...(posted ? ["What was posted there:", posted, ""] : []),
		"PHASE 1 — INGEST (do this first, before anything else):",
		"- Read the ENTIRE thread with your Slack tools — every message, reply, and linked resource (tickets, docs, screenshots).",
		`- Write your digest to ${briefPath} (this task's own brief file): context, who's asking, the exact request, constraints, acceptance criteria, and links. Create the ${BRIEF_DIR}/ dir if needed.`,
		"",
		"PHASE 2 — EXECUTE:",
		`- Work from ${briefPath} as your instructions.`,
		"- Identify the relevant repo/code, investigate, and do the work.",
		"- Verify your changes when practical.",
		"",
		"Rules: do NOT post to Slack or Notion; everything stays in this session for review.",
	].join("\n");
}
