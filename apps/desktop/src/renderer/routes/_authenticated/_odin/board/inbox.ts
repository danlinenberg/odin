import {
	bangCommands,
	isApprovalItem,
	isMoveHereItem,
	isYouOnly,
	itemOptions,
} from "./action-items";
import type { ActionItemEntry } from "./brief";

/**
 * The Inbox: every open action item across sessions in one list, banded by
 * how long it takes you. Read from the item's shape only - no model call.
 */
export type InboxEffort = "quick" | "look" | "think";

export function itemEffort(entry: ActionItemEntry): InboxEffort {
	const { text } = entry;
	if (
		itemOptions(text).options.length > 0 ||
		isApprovalItem(text) ||
		/^\W*merge\b/i.test(text) ||
		entry.fences.some((fence) => bangCommands(fence).length > 0)
	)
		return "quick";
	if (
		isMoveHereItem(text) ||
		isYouOnly(text) ||
		/^\W*(decide|tell me|choose|pick|answer)\b/i.test(text)
	)
		return "think";
	return "look";
}

/** What the board knows about a session that can't move on its own. */
export interface StuckSignals {
	ciGaveUp?: boolean;
	conflicts?: string;
	/** The launch's wait reason and since when, while it waits in line. */
	queued?: { reason: string; since: number };
	diedMidTurn?: boolean;
	failed?: boolean;
	/** Working, and the newest transcript message is this old. */
	working?: { lastMessageAt: number | null };
}

export const QUEUED_STUCK_MS = 30 * 60_000;
export const SILENT_STUCK_MS = 45 * 60_000;

export type StuckFix = "open" | "resume" | "status" | "rebase";

/** Why a session is stuck and the one button that fixes it, or null. */
export function stuckReason(
	s: StuckSignals,
	now = Date.now(),
): { why: string; fix: StuckFix } | null {
	if (s.ciGaveUp) return { why: "CI still red after its fixes", fix: "open" };
	if (s.failed) return { why: "Failed", fix: "open" };
	if (s.diedMidTurn) return { why: "Died mid-turn", fix: "resume" };
	if (s.queued && now - s.queued.since >= QUEUED_STUCK_MS)
		return {
			why: `Queued ${minutes(now - s.queued.since)} - ${s.queued.reason}`,
			fix: "resume",
		};
	if (s.conflicts) return { why: "PR conflicts with main", fix: "rebase" };
	const last = s.working?.lastMessageAt;
	if (last && now - last >= SILENT_STUCK_MS)
		return { why: `No new output for ${minutes(now - last)}`, fix: "status" };
	return null;
}

function minutes(ms: number): string {
	const m = Math.round(ms / 60_000);
	return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
}

export const STATUS_PROMPT =
	"Quick status check from Odin: you have been quiet for a while. In two lines, say what you are doing now and whether something blocks you.";

export const REBASE_PROMPT =
	"Your PR has merge conflicts with main. Rebase it on origin/main, fix the conflicts, run the checks and push.";

// A URL, with or without its scheme for GitHub, ending before trailing punctuation.
const URL_TOKEN = /(?:https?:\/\/|\bgithub\.com\/)[^\s<>()]*[^\s<>().,;:!?'"]/g;

/** "repo#123" for a GitHub PR or issue, else the bare host. */
export function shortLink(url: string): string {
	const bare = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
	const gh = bare.match(/^github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/);
	if (gh) return `${gh[1]}#${gh[2]}`;
	const [host, ...path] = bare.split("/");
	return path.join("") ? `${host}/…` : host;
}

/**
 * A row's text with every URL shortened and a link's echoes ("x (x) <x>",
 * which pasted Slack titles carry) folded into one. A line that was mostly a
 * raw URL said nothing until you hovered it.
 */
export function tidyText(text: string): string {
	return text
		.replace(/\s*<https?:\/\/[^\s>]*$/, "") // an echo cut off mid-URL
		.replace(URL_TOKEN, shortLink)
		.replace(/(\S+)(?:\s*[(<]\1[)>])+/g, "$1");
}
