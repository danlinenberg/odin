import { BRIEF_DIR } from "@odin/shared/constants";
import { slugify } from "./session-launch";

/**
 * How a session reads a Slack, Jira, GitHub, Notion or ClickUp link: its own MCP tools
 * when it has them, and Odin's connection (main/lib/read-link.ts) when they're
 * missing, disconnected or lack access - so the read never depends on what
 * this machine's Claude has set up. $ODIN_PORT is in every session's shell.
 */
export function readVia(provider: string, url: string): string {
	return `with your ${provider} tools. If they're missing, disconnected or lack access, read it through Odin's ${provider} connection instead: curl -sfG "http://127.0.0.1:$ODIN_PORT/read" --data-urlencode "url=${url}"`;
}

/**
 * The prompt every Slack-sourced session starts from - shared by the Slack
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
		// The message itself, quoted - without it the opening prompt is pure Odin
		// plumbing, so Claude's generated title comes out as "Ingest and execute
		// Slack thread task" and Session History has nothing of the real ask to
		// search. `title` is only the message's first line, which is routinely a
		// greeting.
		...(posted ? ["What was posted there:", posted, ""] : []),
		"PHASE 1 - INGEST (do this first, before anything else):",
		`- Read the ENTIRE thread ${readVia("Slack", slackUrl)}`,
		"- Then every linked resource (tickets, docs, PRs, screenshots) - the same fallback reads any Slack, Jira, GitHub, Notion or ClickUp link, and the files it lists.",
		`- Write your digest to ${briefPath} (this task's own brief file): context, who's asking, the exact request, constraints, acceptance criteria, and links. Create the ${BRIEF_DIR}/ dir if needed.`,
		"",
		"PHASE 2 - EXECUTE:",
		`- Work from ${briefPath} as your instructions.`,
		"- Identify the relevant repo/code, investigate, and do the work.",
		"- Verify your changes when practical.",
		// Slack's drafts API yields real mentions, and the session has it as an
		// MCP tool. The fenced copy is the fallback: Odin's Copy button turns its
		// <@USERID> into real mentions when pasted into Slack (CodeBlock.tsx).
		// The draft tool returns a bare channel link, which lands on the channel
		// and not on the thread the draft sits in.
		`- If you end with a reply for me to post in that thread, create it as a Slack draft reply in the thread with your Slack draft tool (slack_send_message_draft, thread_ts of the first message, mentions as <@USERID>) and give me this thread link: ${slackUrl} - not the channel link the tool returns. Never send it. Keep the text in your reply too, in a fenced block with the same <@USERID> mentions, for when the tool is missing.`,
		"",
		"Rules: do NOT post to Slack or Notion; everything stays in this session for review. A Slack draft is not a post: I review and send it myself.",
	].join("\n");
}
