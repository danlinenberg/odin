import { actionItemEntries, actionItemLines } from "./brief";

export { actionItemEntries } from "./brief";

/**
 * Reading a reply's ACTION ITEMS block: where it starts, its items, their
 * [A | B] choices, and which kind each is. Pure, so the board's chat and the
 * iPhone app (renderer/mobile) read a reply the same way.
 */

/**
 * Split a reply at its ACTION ITEMS line, in any of the shapes agents write it
 * ("ACTION ITEMS:", "## Action items", "**ACTION ITEMS:** none ..."). Whatever
 * follows on that line stays with the items.
 */
export function splitActionItems(text: string): {
	body: string;
	actions: string | null;
} {
	const match = text.match(/^[#>*_\s]*ACTION ITEMS\b[*_:\s]*(.*)$/im);
	if (match?.index === undefined) return { body: text, actions: null };
	const rest = text.slice(match.index + match[0].length);
	return {
		body: text.slice(0, match.index).trim(),
		actions: `${match[1] ?? ""}${rest}`.trim() || null,
	};
}

/** An item that asks you to sign off - it gets an Approve button, "(you only)" or not. */
export function isApprovalItem(item: string): boolean {
	return /^\W*approve\b/i.test(item);
}

/**
 * An item asking to move a remote session to your computer ("Move this
 * session to my computer"): the agent on the host is blocked on something
 * only the computer has. It gets a Move button that brings the session here.
 */
export function isMoveHereItem(item: string): boolean {
	return /^\W*move\s+(?:this|the)\s+(?:session|conversation)\s+(?:to|onto)\s+(?:my|this|your)\s+(?:computer|mac|laptop)\b/i.test(
		item,
	);
}

/** The numbered or bulleted lines of an ACTION ITEMS block; [] for "none". */
export const actionItemList = actionItemLines;

/** An ACTION ITEMS block that says nothing is left ("none - shipped"). */
export function noActionItems(actions: string): boolean {
	return (
		/^[\W\d]*none\b/i.test(actions) && actionItemList(actions).length === 0
	);
}

/**
 * An item that asks you to tell Claude something - a choice, a value, a
 * preference. It gets a reply box instead of a bare "Do it".
 */
export function isAnswerItem(item: string): boolean {
	return (
		!isDoneItem(item) &&
		/^\W*(tell|answer|decide|choose|pick|confirm|let me know|say)\b/i.test(item)
	);
}

/**
 * "Tell me when you have authorized X" - the only reply is "done", so it gets
 * a Done button and no reply box.
 */
export function isDoneItem(item: string): boolean {
	return (
		/^\W*(tell me|let me know)\s+(when|once|after)\b/i.test(item) &&
		itemOptions(item).options.length === 0
	);
}

/**
 * The choices Claude offered as a trailing "[A | B | C]", and the item without
 * them. The launch prompt asks for that shape; no brackets means no choices.
 */
export function itemOptions(item: string): { text: string; options: string[] } {
	// Claude sometimes writes the choices as separate brackets, "[A] [B] [C]": read
	// two or more of them (not links) at the end as "[A | B | C]".
	const run = item.match(
		/((?:\[[^[\]|]+\](?!\()\s*){2,})(?=(?:\(you only\))?(?:\s*(?:https?:\/\/\S+|\[[^\]]*\]\([^)]*\)))?\W*$)/i,
	);
	if (run?.index !== undefined) {
		const options = [...(run[1] ?? "").matchAll(/\[([^\]]*)\]/g)].map((m) =>
			m[1]?.trim(),
		);
		item =
			`${item.slice(0, run.index)}[${options.join(" | ")}] ${item.slice(run.index + (run[1] ?? "").length)}`.trim();
	}
	// An option may hold a link ("after [#826](url) merges"); a button shows its words.
	// A trailing "(you only)" still counts: you pick, so the choices are buttons.
	// So does the item's link after them - "Decide #903 [merge | close] <url>" - which stays in the text.
	const match = item.match(
		/\s*\[((?:[^[\]]|\[[^\]]*\]\([^)]*\))*\|(?:[^[\]]|\[[^\]]*\]\([^)]*\))*)\](?!\()\s*(?:\(you only\))?(\s*(?:https?:\/\/\S+|\[[^\]]*\]\([^)]*\)))?\W*$/i,
	);
	if (match?.index === undefined) return { text: item, options: [] };
	const link = match[2]?.trim();
	return {
		text: item.slice(0, match.index) + (link ? ` ${link}` : ""),
		options: (match[1] ?? "")
			.split("|")
			.map((option) =>
				option
					.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
					.trim()
					// The prompt asks for "Odin builds it", but Claude still slips in its own
					// name as the actor. Only a leading "Claude <verb>s" - "Claude app data" stays.
					.replace(/^Claude(?=\s+[a-z]+s\b)/, "Odin"),
			)
			.filter(Boolean),
	};
}

/**
 * What an item's button sends: the typed answer, "Done" for a "tell me when"
 * item, else nothing - and Claude is asked to do the item itself.
 */
export function itemReply(item: string, answer: string): string | undefined {
	const typed = answer.trim();
	if (typed) return typed;
	return !isApprovalItem(item) && isDoneItem(item) ? "Done" : undefined;
}

/** Claude marks what it can't do "(you only)"; handing it back is a dead-end turn. */
export function isYouOnly(item: string): boolean {
	return (
		/\(you only\)\W*$/i.test(item) &&
		!isApprovalItem(item) &&
		!isAnswerItem(item) &&
		itemOptions(item).options.length === 0
	);
}

/** A `! command` block: the command without the `!`, where it starts, and a `#` label written inside it. */
type BangBlock = { command: string; index: number; label?: string };

/**
 * Every `! command` block in `text`, in order. The asked-for shape is a block whose first line starts with `!`.
 * Claude sometimes writes the `!` as the fence's language instead (```!), with `#` label lines above the command:
 * that is the same intent, so it runs too, and the label lines name its button.
 */
function bangBlocks(text: string): BangBlock[] {
	const blocks: BangBlock[] = [];
	for (const match of text.matchAll(/```[^\n]*\n\s*!([\s\S]*?)\n?```/g))
		blocks.push({
			command: outdent(match[1] ?? "", fenceIndent(text, match.index)).trim(),
			index: match.index ?? 0,
		});
	for (const match of text.matchAll(/```![ \t]*\n([\s\S]*?)\n?```/g)) {
		const lines = outdent(match[1] ?? "", fenceIndent(text, match.index)).split(
			"\n",
		);
		// A ```! block whose first line already starts with `!` is the asked-for shape: the first loop has it.
		if ((lines.find((line) => line.trim()) ?? "").trim().startsWith("!"))
			continue;
		const labels: string[] = [];
		while (lines.length && /^\s*(#|$)/.test(lines[0] ?? ""))
			labels.push((lines.shift() ?? "").trim().replace(/^#+\s*/, ""));
		blocks.push({
			command: lines.join("\n").trim(),
			index: match.index ?? 0,
			label: labels.filter(Boolean).join(" ") || undefined,
		});
	}
	return blocks
		.filter((block) => block.command)
		.sort((a, b) => a.index - b.index);
}

/** The spaces before the fence that opens at `index`: a block under a list item sits that far in. */
function fenceIndent(text: string, index = 0): number {
	const lineStart = text.lastIndexOf("\n", index - 1) + 1;
	return text.slice(lineStart, index).match(/^[ \t]*/)?.[0].length ?? 0;
}

/**
 * Each line without the block's own indent - up to `indent` leading spaces, no more. A block under
 * a list item would otherwise run with the item's indent on every line after the first, and a
 * heredoc's `EOF` then never ends it.
 */
function outdent(body: string, indent: number): string {
	if (!indent) return body;
	const margin = new RegExp(`^[ \\t]{0,${indent}}`);
	return body
		.split("\n")
		.map((line) => line.replace(margin, ""))
		.join("\n");
}

/** The `! command` blocks Claude hands you to run in the session, without the `!`. */
export function bangCommands(text: string): string[] {
	return bangBlocks(text).map((block) => block.command);
}

/**
 * The fenced blocks under an item that are not `!` commands - a ```sql query,
 * a config snippet - shown under the item as code. The `!` ones become Run
 * buttons instead.
 */
export function itemSnippets(fences: string[]): string[] {
	return fences.filter((fence) => bangCommands(fence).length === 0).map(dedent);
}

/** Drops the indent a block takes from sitting under a list item: four spaces would turn its fence into plain text. */
function dedent(block: string): string {
	const lines = block.split("\n");
	const indent = Math.min(
		...lines
			.filter((line) => line.trim())
			.map((line) => line.match(/^[ \t]*/)?.[0].length ?? 0),
	);
	return lines.map((line) => line.slice(indent)).join("\n");
}

/**
 * The command of a `!local command` block: one Claude hands you for your own
 * computer rather than its session (a remote session runs on its host). Null
 * for an ordinary `!` command.
 */
export function localCommand(command: string): string | null {
	return command.match(/^local\s+([\s\S]+)$/)?.[1]?.trim() || null;
}

/**
 * The host file of a `!download <path>` block: one a remote session hands you
 * to copy from its host to this computer's Downloads folder. Null for any
 * other command.
 */
export function downloadPath(command: string): string | null {
	const path = command.match(/^download\s+(.+)$/)?.[1]?.trim();
	return path?.replace(/^(["'])(.*)\1$/, "$2") || null;
}

/**
 * The screen of a `!view <port> <password>` block: a VNC server a remote
 * session started on its host (localhost only), which Odin shows in the
 * session's drawer (HostScreenView). Null for any other command.
 */
export function viewTarget(
	command: string,
): { port: number; password: string } | null {
	const match = command.match(/^view\s+(\d{1,5})\s+(\S+)$/);
	const port = Number(match?.[1]);
	return match && port > 0 && port < 65536
		? { port, password: match[2] ?? "" }
		: null;
}

/**
 * What goes back to Claude once a `!local` command ran on this computer: the
 * command, its output and its exit code, fenced past any backticks inside.
 */
export function localRunMessage(
	command: string,
	result: { exitCode: number; output: string },
): string {
	const body = `$ ${command}\n${result.output || "(no output)"}`;
	const longest = Math.max(
		0,
		...[...body.matchAll(/`+/g)].map((match) => match[0].length),
	);
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `I ran this on my computer (exit code ${result.exitCode}):\n\n${fence}\n${body}\n${fence}`;
}

/**
 * What each `! command` does, in Claude's words: the line it wrote right above
 * the block ("A read-only preview:"). A block straight after another block has none.
 */
export function bangCommandNotes(text: string): Record<string, string> {
	const notes: Record<string, string> = {};
	for (const { command, index, label } of bangBlocks(text)) {
		const above = text
			.slice(0, index)
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.at(-1);
		const note =
			above && !above.startsWith("```")
				? above.replace(/^(?:[-*+]|\d+[.)])\s+/, "")
				: label;
		if (note) notes[command] = note;
	}
	return notes;
}

/** A command's note as a button label: its first sentence, as plain text. */
export function commandLabel(note: string): string {
	const plain = note
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[*`]/g, "")
		// Emphasis underscores only: node_modules keeps its own.
		.replace(/(?<!\w)_+|_+(?!\w)/g, "")
		.trim();
	return (plain.split(/(?<=[.!?])\s/)[0] ?? plain).replace(/[.:]+$/, "").trim();
}

const shortPath = (path: string) =>
	path.replace(/\/+$/, "").split("/").at(-1) || path;

/** "16 folders" or the one name: what a command's arguments are, short. */
const things = (args: string[], noun: string) =>
	args.length === 1 ? shortPath(args[0]) : `${args.length} ${noun}`;

/**
 * What a command does, read from the command itself: a Run button's label
 * when Claude wrote no line above its block. Knows the common programs and
 * falls back to "Run <program> <subcommand>", so a label is never the bare
 * command.
 */
export function describeCommand(command: string): string {
	// The step that does the work: not a `cd` before it, nor a filter after.
	const step =
		command
			.split(/&&|\|\||;|\n/)
			.map((part) => part.trim())
			.find((part) => part && !/^cd(\s|$)/.test(part)) ?? command;
	const words = (step.split("|")[0] ?? step)
		.trim()
		.split(/\s+/)
		.filter((word) => !/^\w+=/.test(word) && word !== "sudo");
	const program = shortPath(words[0] ?? "");
	const args = words.slice(1).filter((word) => !word.startsWith("-"));
	const flags = words.slice(1).filter((word) => word.startsWith("-"));
	switch (program) {
		case "rm":
			return `Delete ${things(args, flags.some((f) => /r/i.test(f)) ? "files or folders" : "files")}`;
		case "du":
			return `Show the disk size of ${args.length ? things(args, "folders") : "this folder"}`;
		case "df":
			return "Show the free space left on the disk";
		case "ls":
			return `List ${args.length ? things(args, "folders") : "the files here"}`;
		case "cat":
		case "less":
		case "head":
		case "tail":
			return `Show ${things(args, "files")}`;
		case "mv":
			return `Move ${things(args.slice(0, -1), "files")} to ${shortPath(args.at(-1) ?? "")}`;
		case "cp":
			return `Copy ${things(args.slice(0, -1), "files")} to ${shortPath(args.at(-1) ?? "")}`;
		case "mkdir":
			return `Make the folder ${things(args, "folders")}`;
		case "open":
			return `Open ${args[0] ?? "it"}`;
		case "kill":
		case "pkill":
		case "killall":
			return `Stop the process ${args.join(" ")}`;
		case "curl": {
			const url = args.find((arg) => /^['"]?https?:/.test(arg));
			const host = url?.replace(/^['"]?https?:\/\/([^/'"]+).*$/, "$1");
			return host ? `Call ${host}` : "Make a web request";
		}
	}
	// git push, gh pr merge, aws sso login: the subcommands name the work.
	const sub = args
		.slice(0, program === "aws" || program === "gh" ? 2 : 1)
		.filter((arg) => /^[a-z][\w-]*$/.test(arg));
	return ["Run", program, ...sub].join(" ");
}

/**
 * A reply's `!` commands the phone shows: not `!download`, which puts a file
 * in this computer's Downloads folder, not on the phone, nor `!view`, which
 * opens a window here.
 */
export function phoneCommands(text: string): string[] {
	return bangCommands(text).filter(
		(command) => !downloadPath(command) && !viewTarget(command),
	);
}

/**
 * The `!` commands you can run from the phone: those of Claude's latest reply
 * that has any. The phone shows their Run buttons and the Mac runs only these.
 */
export function runnableCommands(
	messages: { role: string; text: string }[],
): string[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const commands = phoneCommands(message.text);
		if (commands.length) return commands;
	}
	return [];
}

// Words every item uses; sharing one says nothing about which paragraph it means.
const DETAIL_FILLER = new Set(
	"tell what with whether also your this that them they then when have will should about from into once after before merge check open review approve decide choose pick confirm".split(
		" ",
	),
);

/** An item's or paragraph's telling words; a name with `.`, `-`, `_`, `/` or digits counts twice. */
function detailWords(text: string): Map<string, number> {
	const words = new Map<string, number>();
	const prose = text
		.toLowerCase()
		.replace(/\]\([^)]*\)/g, "]")
		.replace(/https?:\/\/\S+/g, " ");
	for (const word of prose.match(
		/[\p{L}\p{N}][\p{L}\p{N}._/-]*[\p{L}\p{N}]/gu,
	) ?? []) {
		const name = /[._/\d-]/.test(word);
		if ((word.length >= 4 || /^\d{2,}$/.test(word)) && !DETAIL_FILLER.has(word))
			words.set(word, name ? 2 : 1);
	}
	return words;
}

/**
 * The paragraph of the reply that explains an item - one that names it ("item
 * 3 below"), else the one sharing the most of its words, and at least one name
 * or two words. null when none does.
 */
export function itemDetail(
	item: string,
	body: string,
	number?: number,
): string | null {
	const blocks = body.split(/\n\s*\n/);
	const named =
		number !== undefined &&
		blocks.find((block) => new RegExp(`\\bitem ${number}\\b`, "i").test(block));
	if (named) return named.trim();
	const words = detailWords(itemOptions(item).text);
	let best: string | null = null;
	let top = 1;
	for (const block of blocks) {
		let score = 0;
		for (const [word, weight] of detailWords(block))
			if (words.has(word)) score += weight;
		if (score > top) {
			best = block.trim();
			top = score;
		}
	}
	return best;
}

// Words too common in commands or items to tell one item from another.
const COMMON_WORDS = new Set([
	"aws",
	"sudo",
	"bash",
	"curl",
	"echo",
	"http",
	"https",
	"www",
	"com",
	"command",
	"commands",
	"then",
	"with",
	"this",
	"that",
	"from",
	"your",
	"only",
	"true",
	"false",
	"json",
	"text",
	"output",
	"region",
	"profile",
	"run",
	"runs",
	"install",
	"apply",
	"execute",
]);

/** A text's distinctive words: lowercased, link targets dropped, 4+ letters or a 3+ digit number. */
function distinctWords(text: string): string[] {
	return text
		.replace(/\]\([^)]*\)/g, "]")
		.toLowerCase()
		.split(/[^a-z0-9-]+/)
		.flatMap((word) => [word, ...(word.includes("-") ? word.split("-") : [])])
		.filter(
			(word) =>
				(/^\d{3,}$/.test(word) || (word.length >= 4 && /[a-z]/.test(word))) &&
				!COMMON_WORDS.has(word),
		);
}

/**
 * How well an item names a command: its words the command shares, an acronym
 * it writes in capitals (IAM, AWS, SSO) that the command has as a word, plus
 * 2 per `quoted` piece of it. An item that tells you to run something gets 1
 * more once it names the command at all: "Run both IAM checks" beats
 * "Choose a path for prod credentials" for `aws iam ... --profile prod`.
 */
export function commandScore(command: string, item: string): number {
	const words = distinctWords(command);
	const shared = new Set(
		distinctWords(item).filter((word) =>
			words.some((other) => other.startsWith(word) || word.startsWith(other)),
		),
	);
	const commandWords = new Set(command.toLowerCase().split(/[^a-z0-9]+/));
	const acronyms = new Set(
		[...item.matchAll(/\b[A-Z]{2,3}\b/g)]
			.map(([word]) => word.toLowerCase())
			.filter((word) => commandWords.has(word)),
	);
	const quoted = [...item.matchAll(/`([^`\n]+)`/g)].filter(([, code]) =>
		command.includes((code ?? "").trim()),
	);
	const runs = /^(optional:\s*)?(run|execute|install)\b/i.test(item.trim());
	// Loose shared words count only for an item that tells you to run
	// something: "Free about 17 GB more [Claude app data]" shared "app" and
	// "data" with a delete under `/System/Volumes/Data` and took the buttons
	// from "Run the three commands above".
	const score = (runs ? shared.size : 0) + acronyms.size + 2 * quoted.length;
	return score > 0 && runs ? score + 1 : score;
}

/**
 * The item a reply's `!` command goes under, -1 for the card's foot: the item
 * it was written under (`under[i]` holds item i's own commands), else the item
 * that names it best, else the first item that opens with run, execute or
 * install, else the first that says one of them.
 */
export function commandItem(
	command: string,
	items: string[],
	under: string[][] = [],
): number {
	const own = under.findIndex((commands) => commands.includes(command));
	if (own >= 0) return own;
	let best = -1;
	let bestScore = 0;
	items.forEach((item, index) => {
		const score = commandScore(command, item);
		if (score > bestScore) {
			best = index;
			bestScore = score;
		}
	});
	if (best >= 0) return best;
	// An item that tells you to run something ("Run the reset command...")
	// before one that only mentions it: "comment `terrateam apply`" on an
	// approve item took the button from the run item below it.
	const opens = items.findIndex((item) =>
		/^(optional:\s*)?(run|execute|install)\b/i.test(item.trim()),
	);
	if (opens >= 0) return opens;
	return items.findIndex((item) => /\b(run|execute|install)\b/i.test(item));
}

/**
 * Where a reply's `!` commands go on the phone, as on the board: under[i]
 * holds item i's commands (the item each was written under, else the one
 * that names it best - see commandItem), foot the ones no item claims.
 */
export function placeCommands(
	actions: string,
	commands: string[],
): { under: string[][]; foot: string[] } {
	const entries = actionItemEntries(actions);
	const items = entries.map(({ text }) => text);
	const own = entries.map(({ fences }) => fences.flatMap(bangCommands));
	const under = items.map((): string[] => []);
	const foot: string[] = [];
	for (const command of commands) {
		const home = commandItem(command, items, own);
		if (home >= 0) under[home]?.push(command);
		else foot.push(command);
	}
	return { under, foot };
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

const MOVES_PR_ALONG = /^\W*(merge|review|approve|land|ship)\b/i;

/** The GitHub PR links an item names, each once. */
export function itemPullRequests(item: string): string[] {
	return [...new Set(item.match(PR_URL) ?? [])];
}

/**
 * How an item's PRs ended, when every one of them has: "Merge PR #12" for a PR
 * you merged before the reply was written. Null while any is still open, or
 * its state is not known yet - an unknown PR is never shown as done. Only an
 * item asking you to move the PR along counts: "Revert PR #12" still has work
 * in it after #12 merged.
 */
export function settledItem(
	item: string,
	states: Record<string, { state: string } | null | undefined> | undefined,
): "MERGED" | "CLOSED" | null {
	const urls = itemPullRequests(item);
	if (urls.length === 0 || !states || !MOVES_PR_ALONG.test(item)) return null;
	const ends = urls.map((url) => states[url]?.state);
	if (!ends.every((end) => end === "MERGED" || end === "CLOSED")) return null;
	return ends.includes("MERGED") ? "MERGED" : "CLOSED";
}
