import { SHELL_RULE } from "./constants";
import { isVideoFile } from "./file-types";
import { type OdinRule, rulesPrompt } from "./odin-rules";

/*
 * How a task becomes a Claude session: the prompt file it reads, and the
 * identity its card carries. Shared so a session started by the window and
 * one a remote server's scheduler starts (main/odin-core) read the same.
 */

export function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "task"
	);
}

/** Single-quote a path for the shell - repo paths come off the user's disk. */
export function quote(path: string): string {
	return `'${path.replaceAll("'", `'\\''`)}'`;
}

/** Heads the context a person added when they started the session. */
export const GUIDELINES_HEADER =
	"Context and guidelines from me for this session - keep them in mind throughout:";

/**
 * What every task prompt ends with. Settings -> Sessions can replace it
 * (`useSessionInstructions`); this is what Reset goes back to.
 */
export const DEFAULT_SESSION_INSTRUCTIONS = [
	"Work in the current workspace. Investigate, make the changes, and verify them when practical.",
	// A subagent or a background Bash runs it where nobody can see it; the
	// card's Shell is where I'd look for it.
	"",
	SHELL_RULE,
	// Every session lands on the board, and most of them land under "Needs
	// you" - where the only question being asked is "what do I have to do
	// about this one?". A turn that stops at "here's what I found" makes
	// you read the whole transcript to answer it.
	"",
	// "Update the contract to 0" makes me write the SQL myself.
	"When I have to run something you may not run yourself - a database write, a production change - give me the exact copy-pasteable commands above ACTION ITEMS: a read-only preview, the change, and a check that it worked. Never only describe it. Put each command in its own fenced block whose first line starts with `!`, e.g. `! aws sso login --profile dev`: Odin shows a Run button for those. A database or schema change is the exception: never give it as a `!` command. Give me the exact query (the preview SELECT, the UPDATE/INSERT/DELETE/ALTER, and the check SELECT) in a ```sql block, for me to run in my own DB client.",
	"",
	// Items that carry their own background and options turn the list
	// back into a transcript; the reasoning already lives above it.
	'Finish every reply with a section headed "ACTION ITEMS": a short numbered list of what I - the human reviewing this - have to do next (decide something, run or check something, unblock you). Anything you left open is an item: a PR not merged, a change not live yet, a question you are asking me. Shipped work is not: no "review this" for something already merged. One line per item, an imperative of about 12 words or fewer - no background, reasons or option lists (those belong above the section). When an item asks me to choose, end it with the choices in brackets, like "Tell me the export format [CSV | shareable page]". When an item tells me to open, check or watch something - a page, PR, file or app - put its link in the item. End an item with "(you only)" when you cannot do it yourself - no access, or the rules forbid it. If there is nothing for me to do, write "ACTION ITEMS: none" and say why in a few words.',
].join("\n");

export function buildPrompt(
	title: string,
	description: string | null,
	attachmentPaths: string[] = [],
	skill?: string,
	unattended = false,
	rules: OdinRule[] = [],
	checkout = "",
	guidelines = "",
	instructions = DEFAULT_SESSION_INSTRUCTIONS,
	worktree: { path: string; branch: string } | null = null,
): string {
	return [
		// A skill leads the prompt, on its own line, with the title as its
		// argument - the shape a person types. Anywhere else in the text it's
		// prose about a skill rather than an invocation of one.
		skill ? `/${skill} ${title}` : `Task: ${title}`,
		...(description ? ["", description] : []),
		...(attachmentPaths.length > 0
			? [
					"",
					"Attached files - read them before starting:",
					...attachmentPaths,
					// The agent can't open a video: say so once, with the way in.
					...(attachmentPaths.some(isVideoFile)
						? [
								"",
								"Videos can't be read directly - pull frames first, e.g. `ffmpeg -i <video> -vf fps=1 /tmp/frame-%03d.png`, then read those.",
							]
						: []),
				]
			: []),
		...(guidelines.trim() ? ["", GUIDELINES_HEADER, guidelines.trim()] : []),
		// A scheduled run reads exactly like one I typed, so the agent stops on
		// the first ambiguity and waits - at 4am, for hours, for nobody.
		...(unattended
			? [
					"",
					"This run was started by a schedule, not by a person - nobody is watching it. Don't stop to ask something you can settle with a sensible default: make the call, say which one you made, and leave the question in ACTION ITEMS.",
				]
			: []),
		...rulesPrompt(rules, checkout),
		...(worktree
			? ["", worktreeMadeLine(worktree)]
			: checkout
				? []
				: ["", WORKTREE_ASK_LINE]),
		...(instructions.trim() ? ["", instructions.trim()] : []),
	].join("\n");
}

const worktreeMadeLine = ({ path, branch }: { path: string; branch: string }) =>
	`Odin made this session its own git worktree: ${path} (branch ${branch}, cut from the repo's default branch). Work only there and don't make another worktree. Install dependencies first if the repo needs them.`;

/** A launch into the repos folder: Odin can't know the repo until the agent picks it. */
export const WORKTREE_ASK_LINE =
	"Before you change files in a git repo, get your own worktree from Odin: `curl -sf http://127.0.0.1:$ODIN_PORT/odin --data-urlencode action=worktree --data-urlencode repo=<the repo's main checkout> --data-urlencode name=<short task name>` prints its path (a new branch from the default branch). cd there and work only there. Skip this if you're already in a worktree, or only read code.";

/** Mime subtypes whose obvious extension isn't the subtype itself. */
const EXTENSIONS: Record<string, string> = {
	jpeg: "jpg",
	quicktime: "mov",
	"x-matroska": "mkv",
	"svg+xml": "svg",
};

/**
 * Split a `data:image/png;base64,…` (or `data:video/mp4;…`) URL into what the
 * filesystem router wants. Extension comes from the mime type, never the
 * original filename - the name is user-supplied and would need sanitising to
 * be safe in a path.
 */
export function parseDataUrl(dataUrl: string): {
	base64: string;
	extension: string;
} {
	const [header = "", base64 = ""] = dataUrl.split(",", 2);
	const subtype =
		/^data:(?:image|video)\/([a-z0-9.+-]+)/i.exec(header)?.[1]?.toLowerCase() ??
		"png";
	return {
		base64,
		extension: EXTENSIONS[subtype] ?? subtype.replace(/[^a-z0-9]/gi, ""),
	};
}

/** Which Odin view launched a session - "slack" is the retired reactions alias. */
export type OdinSource = "slack" | "reactions" | "jira" | "pr" | "notion";

/** A work-ledger row, as much of it as a board card needs. */
export interface DelegatedWork {
	title: string;
	person: string | null;
	externalId: string;
	source: string;
}

/**
 * What the board shows for a session: what the caller passed, filled in from
 * the work ledger's row for the same conversation.
 *
 * The caller wins everywhere except the title, and there the ledger does. A
 * resume only knows a conversation by what the transcript is called - Claude's
 * own summary of it, e.g. "Ingest and execute Slack thread task" - while the
 * ledger remembers the ask it was started from.
 */
export function boardIdentity(
	passed: {
		title: string;
		contact?: string | null;
		pageId?: string | null;
		source?: OdinSource;
		key?: string;
	},
	delegated?: DelegatedWork,
): {
	title: string;
	contact: string | null;
	pageId: string | null;
	source: OdinSource | undefined;
	key: string | undefined;
} {
	return {
		title: delegated?.title ?? passed.title,
		contact: passed.contact ?? delegated?.person ?? null,
		pageId: passed.pageId ?? delegated?.externalId ?? null,
		source: passed.source ?? (delegated?.source as OdinSource | undefined),
		key: passed.key ?? delegated?.externalId,
	};
}
