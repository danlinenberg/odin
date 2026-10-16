import { odinIcon } from "@odin/ui/icons/preset-icons";
import { toast } from "@odin/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@odin/ui/tooltip";
import { cn } from "@odin/ui/utils";
import {
	isValidElement,
	memo,
	type ReactElement,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	LuChevronRight,
	LuMic,
	LuSquareTerminal,
	LuWrench,
} from "react-icons/lu";
import { MarkdownRenderer } from "renderer/components/MarkdownRenderer";
import { isHotkey, useHotkeyDisplay } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { shellEscapePaths } from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/utils";
import { draftFor, useChatDrafts } from "renderer/stores/chat-drafts";
import { useCompacting } from "renderer/stores/compacting";
import {
	isDismissed,
	useDismissedActions,
	withDismissals,
} from "renderer/stores/dismissed-actions";
import { openUrl } from "renderer/stores/in-app-browser";
import { useSessionView } from "renderer/stores/session-view";
import {
	getImageMimeType,
	getVideoMimeType,
	isPreviewableVideoFile,
} from "shared/file-types";
import { freshTldr, sameReply, tldrPlacement } from "shared/latest-reply";
import { inputBoxRows, odinScreenStatus } from "shared/odin-screen-status";
import stripAnsi from "strip-ansi";
import {
	insertSkill,
	matchSkills,
	skillToken,
} from "../components/skill-picker";
import { attachmentPaths } from "../components/TaskBox";
import { COMPACT_MARKDOWN } from "../components/TranscriptView";
import { actionItemLines } from "./brief";
import {
	PlanCard,
	QuestionCard,
	ScreenAsideCard,
	ScreenMenuCard,
} from "./ChatPrompts";
import { collectRefs, linkify } from "./chat-links";
import { parseScreenAside, parseScreenMenu } from "./screen-menu";
import { useHoldToTalk } from "./voice";

type Item =
	| {
			kind: "user";
			id: string;
			text: string;
			images?: string[];
			/** When you sent it (ms) - a turn's start. Unset for a mid-turn queued message. */
			at?: number;
	  }
	| {
			kind: "text";
			id: string;
			text: string;
			msg?: string;
			out?: number;
			/** When Claude wrote it (ms) - matches the brief to the reply it read. */
			at?: number;
	  }
	| {
			kind: "tool";
			id: string;
			/** The API message it came in, and that message's output tokens so far. */
			msg?: string;
			out?: number;
			name: string;
			input: Record<string, unknown>;
			result?: string;
			isError?: boolean;
	  }
	| {
			kind: "compact";
			id: string;
			/** When it finished (ms). */
			at?: number;
			summary?: string;
			preTokens?: number;
			postTokens?: number;
			durationMs?: number;
	  };

type Block = {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: string | Block[];
	is_error?: boolean;
	source?: { type?: string; media_type?: string; data?: string };
};

type Line = {
	type?: string;
	uuid?: string;
	isMeta?: boolean;
	isSidechain?: boolean;
	subtype?: string;
	timestamp?: string;
	compactMetadata?: {
		preTokens?: number;
		postTokens?: number;
		durationMs?: number;
	};
	/** The summary Claude continues from - long, and not something you typed. */
	isCompactSummary?: boolean;
	message?: {
		id?: string;
		content?: string | Block[];
		usage?: { output_tokens?: number };
	};
	/** A message you sent mid-turn rides in as a queued_command attachment. */
	attachment?: { type?: string; prompt?: string | Block[] };
	/** queue-operation lines: Claude holding a message until it is free. */
	operation?: string;
	content?: string;
};

/** First read takes the transcript's tail - a long session's JSONL runs to MBs. */
const TAIL_BYTES = 4_000_000;
const POLL_MS = 1_000;

/** Where Claude files a conversation: its cwd with every non-alphanumeric as "-". */
export function transcriptPath(home: string, cwd: string, sessionId: string) {
	return `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${sessionId}.jsonl`;
}

/** What a user turn shows: no hook/system chatter, a slash command as itself. */
export function userText(text: string): string | null {
	const command = text.match(/<command-name>([^<]*)<\/command-name>/);
	if (command) return command[1] ?? null;
	const bash = text.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
	if (bash) return `!${bash[1]}`;
	if (/^\s*<bash-stdout>/.test(text))
		return text.replace(/<\/?bash-(stdout|stderr)>/g, "\n").trim() || null;
	// A built-in command's reply (/cost, /context, /model): its output, plain.
	if (/^\s*<local-command-std(out|err)>/.test(text))
		return (
			stripAnsi(
				text.replace(/<\/?local-command-std(out|err)>/g, "\n"),
			).trim() || null
		);
	if (/^\s*<(local-command|task-notification)/.test(text)) return null;
	if (text.startsWith("Caveat:")) return null;
	const stripped = text
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
		.trim();
	return stripped || null;
}

function blockText(content: string | Block[] | undefined): string {
	if (typeof content === "string") return content;
	return (content ?? [])
		.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
		.join("\n");
}

/** A message sent mid-turn reads as the user turn it is, its images too - with no time, it starts no turn. */
function unqueue(line: Line): Line {
	if (line.attachment?.type !== "queued_command") return line;
	return {
		...line,
		type: "user",
		timestamp: undefined,
		message: { content: line.attachment.prompt },
	};
}

/**
 * Fold new JSONL lines into the item list. Append-only, except a tool_result
 * fills in the tool row it answers - that row gets a new object, the rest keep
 * theirs, so memoized rows don't re-render.
 */
export function applyLines(items: Item[], lines: Line[]): Item[] {
	const next = [...items];
	const toolIndex = new Map<string, number>();
	next.forEach((item, index) => {
		if (item.kind === "tool") toolIndex.set(item.id, index);
	});
	lines.map(unqueue).forEach((line, lineIndex) => {
		if (line.isMeta || line.isSidechain) return;
		const id = line.uuid ?? `${items.length}-${lineIndex}`;
		if (line.subtype === "compact_boundary") {
			const { preTokens, postTokens, durationMs } = line.compactMetadata ?? {};
			next.push({
				kind: "compact",
				id,
				at: line.timestamp ? Date.parse(line.timestamp) : undefined,
				preTokens,
				postTokens,
				durationMs,
			});
			return;
		}
		if (line.isCompactSummary) {
			const summary = blockText(line.message?.content);
			const last = next.at(-1);
			if (last?.kind === "compact")
				next[next.length - 1] = { ...last, summary };
			else next.push({ kind: "compact", id, summary });
			return;
		}
		if (!line.message) return;
		const content = line.message.content;
		const at = line.timestamp ? Date.parse(line.timestamp) : undefined;
		if (line.type === "user") {
			if (typeof content === "string") {
				const text = userText(content);
				if (text) next.push({ kind: "user", id, text, at });
				return;
			}
			// A pasted image is an image block beside "[Image #N] ..." text.
			const images = (content ?? []).flatMap((block) =>
				block.type === "image" && block.source?.type === "base64"
					? [`data:${block.source.media_type};base64,${block.source.data}`]
					: [],
			);
			let imagesShown = images.length === 0;
			for (const [i, block] of (content ?? []).entries()) {
				if (block.type === "tool_result" && block.tool_use_id) {
					const index = toolIndex.get(block.tool_use_id);
					const tool = index === undefined ? undefined : next[index];
					if (index !== undefined && tool?.kind === "tool")
						next[index] = {
							...tool,
							result: blockText(block.content),
							isError: block.is_error,
						};
				} else if (block.type === "text" && block.text) {
					const raw = userText(block.text);
					const text = imagesShown
						? raw
						: (raw?.replace(/\[Image #\d+\]\s*/g, "").trim() ?? "");
					if (text === null || (!text && imagesShown)) continue;
					next.push({
						kind: "user",
						id: `${id}:${i}`,
						text,
						at,
						...(imagesShown ? {} : { images }),
					});
					imagesShown = true;
				}
			}
			if (!imagesShown) next.push({ kind: "user", id, text: "", images, at });
		} else if (line.type === "assistant" && Array.isArray(content)) {
			const msg = line.message.id;
			const out = line.message.usage?.output_tokens;
			for (const [i, block] of content.entries()) {
				if (block.type === "text" && block.text?.trim())
					next.push({
						kind: "text",
						id: `${id}:${i}`,
						text: block.text,
						msg,
						out,
						at,
					});
				else if (block.type === "tool_use" && block.id) {
					toolIndex.set(block.id, next.length);
					next.push({
						kind: "tool",
						id: block.id,
						name: block.name ?? "Tool",
						input: block.input ?? {},
						msg,
						out,
					});
				}
			}
		}
	});
	return next;
}

/**
 * The messages Claude holds in its queue - sent while it was busy (a turn, a
 * `!` command) - oldest first. Claude logs each enqueue at once, so they show
 * even when Odin thought it was idle or the drawer was switched away.
 */
export function applyQueue(queue: string[], lines: Line[]): string[] {
	const next = [...queue];
	for (const raw of lines) {
		const line = unqueue(raw);
		// The log drifts (a remove that matches nothing, a resume that never
		// logs its dequeues), so a message that lands as a turn also clears
		// itself and everything queued before it.
		if (line.type === "user") {
			const text = blockText(line.message?.content).trim();
			const index = text
				? next.findIndex((item) => item.trim() && text.includes(item.trim()))
				: -1;
			if (index >= 0) next.splice(0, index + 1);
			continue;
		}
		if (line.type !== "queue-operation") continue;
		if (line.operation === "enqueue" && line.content) next.push(line.content);
		else if (line.operation === "dequeue") next.shift();
		// Esc pulls every queued message back into Claude's input box.
		else if (line.operation === "popAll") next.length = 0;
		else if (line.operation === "remove") {
			const index = next.indexOf(line.content ?? "");
			if (index >= 0) next.splice(index, 1);
		}
	}
	return next;
}

/** A message you just sent, shown until Claude's transcript echoes it. */
type Sent = {
	id: number;
	text: string;
	previews?: Preview[];
	seen: Set<string>;
	/** Claude never took it: no turn, nothing queued. */
	lost?: boolean;
};

/**
 * Sends still waiting on their echo, per pane. A resume swaps the ended
 * session's view for the live one; the bubble rides along instead of
 * vanishing until Claude has booted and written the message.
 */
const carried = new Map<string, Sent[]>();

/**
 * Claude took something since the send: a user row that wasn't there, or the
 * message waiting in its queue. Any new row counts - Claude rewrites some
 * messages (a slash command echoes as its name), so the text can't decide.
 */
export function arrived(
	items: { kind: string; id: string }[],
	queue: string[],
	sent: Pick<Sent, "text" | "seen">,
): boolean {
	return (
		items.some((item) => item.kind === "user" && !sent.seen.has(item.id)) ||
		queue.some((text) => text.includes(sent.text))
	);
}

/**
 * Claude echoed the sent message: a user row that was not there at the send
 * holds its text. Older rows don't count - a photo sent alone has no text, and
 * every row "includes" the empty string.
 */
export function isEchoed(
	items: { kind: string; id: string; text?: string }[],
	sent: Pick<Sent, "text" | "seen">,
): boolean {
	return items.some(
		(item) =>
			item.kind === "user" &&
			!sent.seen.has(item.id) &&
			(item.text ?? "").includes(sent.text),
	);
}

/** Your queued messages: background-task notices ride the same queue. */
export function yourQueued(queue: string[]): string[] {
	return queue.filter((text) => !text.startsWith("<task-notification"));
}

function parseLines(parts: string[]): Line[] {
	return parts.flatMap((part) => {
		try {
			return [JSON.parse(part) as Line];
		} catch {
			return [];
		}
	});
}

function readBytes(read: { kind: string; content: unknown }): Uint8Array {
	// Native decode: Uint8Array.from(atob(...), fn) took ~100ms on a 4MB tail.
	return read.kind === "bytes"
		? (
				Uint8Array as unknown as { fromBase64: (b64: string) => Uint8Array }
			).fromBase64(read.content as string)
		: new TextEncoder().encode(read.content as string);
}

/**
 * Where each transcript's reader stopped, kept when its view unmounts, so
 * switching back to a session shows it at once and reads only what's new.
 * ponytail: the last 20 sessions, oldest out first; a file rewritten shorter
 * than the kept offset is not detected.
 */
interface LiveState {
	offset: number | null;
	skipFirstLine: boolean;
	remainder: string;
	decoder: TextDecoder;
	start: number;
	head: Uint8Array;
	items: Item[];
	queued: string[];
}
const liveCache = new Map<string, LiveState>();

/**
 * An earlier chunk of the transcript, joined to `head` - the first half of the
 * line the loaded window starts on, cut where the window began. Returns the
 * whole lines, and the new cut line unless the chunk reached the file's start.
 */
export function splitEarlier(
	earlier: Uint8Array,
	head: Uint8Array,
	atFileStart: boolean,
): { lines: string[]; head: Uint8Array } {
	const bytes = new Uint8Array(earlier.length + head.length);
	bytes.set(earlier);
	bytes.set(head, earlier.length);
	const parts: Uint8Array[] = [];
	for (let at = 0; at <= bytes.length; ) {
		const cut = bytes.indexOf(10, at);
		const end = cut < 0 ? bytes.length : cut;
		parts.push(bytes.subarray(at, end));
		at = end + 1;
	}
	const cutLine = atFileStart ? undefined : parts.shift();
	const decoder = new TextDecoder();
	return {
		lines: parts.map((part) => decoder.decode(part)),
		head: cutLine ? cutLine.slice() : new Uint8Array(0),
	};
}

/**
 * The transcript, tailed: one read of the last TAIL_BYTES, then only the bytes
 * appended since. The old full read re-parsed the whole file every poll.
 * `loadEarlier` reads the TAIL_BYTES before what's loaded - a long session's
 * start sits megabytes back, and a resumed one is always a long one.
 */
function useLiveItems(path: string | null, workspaceId: string) {
	const [items, setItems] = useState<Item[]>([]);
	const [queued, setQueued] = useState<string[]>([]);
	const [missing, setMissing] = useState<string | null>(null);
	const [hasEarlier, setHasEarlier] = useState(false);
	// Bumps once per loaded earlier chunk, in the same render as its rows.
	const [earlierLoads, setEarlierLoads] = useState(0);
	const utils = electronTrpc.useUtils();
	// Read now instead of at the next poll - after a send, so Claude's echo of
	// your message lands as soon as it's written.
	const pokeRef = useRef(() => {});
	const loadEarlierRef = useRef(async () => false);
	useEffect(() => {
		if (!path) return;
		let cancelled = false;
		const saved = liveCache.get(path);
		let offset: number | null = saved?.offset ?? null;
		let skipFirstLine = saved?.skipFirstLine ?? false;
		let remainder = saved?.remainder ?? "";
		const decoder = saved?.decoder ?? new TextDecoder();
		// Where the loaded window starts, and the cut line it starts with: the
		// earlier chunk ends with that line's first half.
		let start = saved?.start ?? 0;
		let head: Uint8Array = saved?.head ?? new Uint8Array(0);
		let loadingEarlier = false;
		let timer: ReturnType<typeof setTimeout>;
		let running = false;
		let again = false;
		// Mirrors of the state below, so the cleanup keeps rows that match offset.
		let shown = saved?.items ?? [];
		let shownQueue = saved?.queued ?? [];
		setItems(shown);
		setQueued(shownQueue);
		setMissing(null);
		setHasEarlier(start > 0);
		const tick = async () => {
			if (running) {
				again = true;
				return;
			}
			running = true;
			clearTimeout(timer);
			try {
				if (offset === null) {
					const meta = await utils.client.filesystem.getMetadata.query({
						workspaceId,
						absolutePath: path,
					});
					if (!meta) {
						if (!cancelled) setMissing(`Not on disk yet: ${path}`);
						// Claude writes the file on its first turn - keep looking.
						running = false;
						timer = setTimeout(tick, POLL_MS * 3);
						return;
					}
					offset = Math.max(0, (meta.size ?? 0) - TAIL_BYTES);
					skipFirstLine = offset > 0;
					start = offset;
					if (!cancelled) setHasEarlier(start > 0);
				}
				const read = await utils.client.filesystem.readFile.query({
					workspaceId,
					absolutePath: path,
					offset,
					maxBytes: TAIL_BYTES,
				});
				if (cancelled) return;
				if (read.byteLength > 0) {
					offset += read.byteLength;
					const bytes = readBytes(read);
					if (skipFirstLine) {
						const cut = bytes.indexOf(10);
						head = bytes.slice(0, cut < 0 ? bytes.length : cut);
					}
					const chunk = remainder + decoder.decode(bytes, { stream: true });
					const parts = chunk.split("\n");
					remainder = parts.pop() ?? "";
					if (skipFirstLine) {
						parts.shift();
						skipFirstLine = false;
					}
					const lines = parseLines(parts);
					if (lines.length) {
						shown = applyLines(shown, lines);
						shownQueue = applyQueue(shownQueue, lines);
						setItems(shown);
						setQueued(shownQueue);
					}
				}
				setMissing(null);
			} catch (error) {
				if (!cancelled)
					setMissing(error instanceof Error ? error.message : String(error));
			}
			running = false;
			if (!cancelled) timer = setTimeout(tick, again ? 0 : POLL_MS);
			again = false;
		};
		loadEarlierRef.current = async () => {
			// Not before the tail's first read: it's what finds the cut line.
			if (start === 0 || loadingEarlier || offset === null || offset === start)
				return false;
			loadingEarlier = true;
			try {
				const from = Math.max(0, start - TAIL_BYTES);
				const read = await utils.client.filesystem.readFile.query({
					workspaceId,
					absolutePath: path,
					offset: from,
					maxBytes: start - from,
				});
				if (cancelled) return false;
				const split = splitEarlier(readBytes(read), head, from === 0);
				head = split.head;
				start = from;
				// ponytail: a tool row whose result sits past the cut stays without
				// it; the tail window already dropped that result.
				const rows = applyLines([], parseLines(split.lines));
				shown = [...rows, ...shown];
				setItems(shown);
				setEarlierLoads((n) => n + 1);
				setHasEarlier(from > 0);
				return true;
			} catch (error) {
				if (!cancelled)
					setMissing(error instanceof Error ? error.message : String(error));
				return false;
			} finally {
				loadingEarlier = false;
			}
		};
		pokeRef.current = () => void tick();
		void tick();
		return () => {
			cancelled = true;
			clearTimeout(timer);
			// A read still in flight is dropped before it moves offset or rows.
			liveCache.delete(path);
			if (offset === null) return;
			liveCache.set(path, {
				offset,
				skipFirstLine,
				remainder,
				decoder,
				start,
				head,
				items: shown,
				queued: shownQueue,
			});
			if (liveCache.size > 20)
				liveCache.delete(liveCache.keys().next().value as string);
		};
	}, [path, workspaceId, utils]);
	return {
		items,
		queued,
		missing,
		poke: () => pokeRef.current(),
		hasEarlier,
		earlierLoads,
		loadEarlier: () => loadEarlierRef.current(),
	};
}

function toolSummary(input: Record<string, unknown>): string {
	for (const key of [
		"command",
		"file_path",
		"pattern",
		"description",
		"url",
		"query",
		"prompt",
		"skill",
	]) {
		const value = input[key];
		if (typeof value === "string" && value) return value.split("\n")[0] ?? "";
	}
	return "";
}

const base = (path: unknown) =>
	typeof path === "string" ? (path.split("/").pop() ?? path) : "";

/**
 * What a tool call is doing, in words: Claude writes a description for every
 * command and agent, the rest read off the file or pattern. The raw input
 * stays one click under it.
 */
export function toolDescription(tool: Pick<Tool, "name" | "input">): string {
	const { name, input } = tool;
	if (typeof input.description === "string" && input.description)
		return input.description;
	switch (name) {
		case "Read":
			return `Read ${base(input.file_path)}`;
		case "Edit":
		case "MultiEdit":
			return `Edited ${base(input.file_path)}`;
		case "Write":
			return `Wrote ${base(input.file_path)}`;
		case "Grep":
		case "Glob":
			return `Searched for ${input.pattern}`;
		case "Skill":
			return `Used the ${input.skill} skill`;
		case "WebFetch":
			return `Opened ${input.url}`;
		case "WebSearch":
			return `Searched the web for ${input.query}`;
	}
	return `${name} ${toolSummary(input)}`.trim();
}

/** Colour +/- lines green/red like the terminal, only for output that has a diff hunk. */
function DiffColored({ text }: { text: string }) {
	if (!/^@@ /m.test(text)) return <>{text}</>;
	return text.split("\n").map((line, index) => (
		<div
			// biome-ignore lint/suspicious/noArrayIndexKey: static lines, never reordered
			key={index}
			className={cn(
				/^\+(?!\+\+ )/.test(line) && "text-emerald-400",
				/^-(?!-- )/.test(line) && "text-danger",
			)}
		>
			{line || "\u00a0"}
		</div>
	));
}

const ToolRow = memo(function ToolRow({
	item,
}: {
	item: Extract<Item, { kind: "tool" }>;
}) {
	const [open, setOpen] = useState(false);
	const done = item.result !== undefined;
	const oldText = item.input.old_string;
	const newText = item.input.new_string;
	return (
		<div className="text-[12.5px]">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-secondary"
			>
				<span
					className={cn(
						"size-[7px] shrink-0 rounded-full",
						!done && "animate-pulse bg-working",
						done && (item.isError ? "bg-danger" : "bg-emerald-500"),
					)}
				/>
				<span className="min-w-0 truncate text-foreground">
					{toolDescription(item)}
				</span>
				<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint-foreground">
					{item.name}
				</span>
				<span className="ml-auto shrink-0 text-[10px] text-faint-foreground">
					{open ? "▾" : "▸"}
				</span>
			</button>
			{open && (
				<div className="ml-4 mt-1 select-text cursor-text space-y-2 border-l border-border pl-3">
					{typeof oldText === "string" && typeof newText === "string" ? (
						<pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px]">
							<div className="bg-danger/10 text-danger">
								{oldText.replace(/^/gm, "- ")}
							</div>
							<div className="bg-emerald-500/10 text-emerald-400">
								{newText.replace(/^/gm, "+ ")}
							</div>
						</pre>
					) : (
						<pre className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-soft-foreground">
							{typeof item.input.command === "string"
								? item.input.command
								: JSON.stringify(item.input, null, 2)}
						</pre>
					)}
					{done && item.result && (
						<pre
							className={cn(
								"max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary/60 p-2 font-mono text-[11.5px]",
								item.isError ? "text-danger" : "text-muted-foreground",
							)}
						>
							{/* ponytail: capped - a 2MB tool output in a <pre> stalls the drawer */}
							<DiffColored text={item.result.slice(0, 20_000)} />
						</pre>
					)}
				</div>
			)}
		</div>
	);
});

type Tool = Extract<Item, { kind: "tool" }>;
type Group = Tool[];

/**
 * Runs of tool calls fold into one group, like the desktop app hides its
 * commands. Claude's narration between runs stays visible - it is the
 * conversation; only the commands are technical noise.
 */
export function segments(items: Item[]): (Item | Group)[] {
	const out: (Item | Group)[] = [];
	for (const item of items) {
		const last = out.at(-1);
		if (item.kind !== "tool") out.push(item);
		else if (Array.isArray(last)) last.push(item);
		else out.push([item]);
	}
	return out;
}

/** A question or plan approval Claude is still waiting on - a menu only the TUI draws. */
function asking(items: Item[]): Tool | null {
	const last = items.at(-1);
	return last?.kind === "tool" &&
		last.result === undefined &&
		(last.name === "AskUserQuestion" || last.name === "ExitPlanMode")
		? last
		: null;
}

const ToolGroup = memo(
	function ToolGroup({
		group,
		lead,
	}: {
		group: Group;
		/** The line Claude wrote before this run - the toggle sits at its end. */
		lead?: ReactNode;
	}) {
		const [open, setOpen] = useState(false);
		// A failure Claude retried past is routine; only flag a run that ended failing.
		const failed = group.at(-1)?.isError === true;
		return (
			<div className="flex min-w-0 flex-col">
				{/* Alone on its row, the toggle centres on Claude's mark beside it. */}
				<div
					className={cn(
						"flex min-w-0 gap-2",
						lead ? "items-end" : "h-7 items-center",
					)}
				>
					{/* A line hugs the toggle. An action-items card takes the row: as a size container it has no width of its own. */}
					{lead && (
						<div className="min-w-0 has-[[data-action-items]]:flex-1">
							{lead}
						</div>
					)}
					{/* Live work shows once, in the turn's own "Working..." row below. */}
					<button
						type="button"
						onClick={() => setOpen((value) => !value)}
						title={failed ? "Worked - ended in an error" : "Worked"}
						aria-label={failed ? "Worked, ended in an error" : "Worked"}
						aria-expanded={open}
						className={cn(
							"shrink-0 rounded p-0.5 text-faint-foreground hover:bg-accent hover:text-foreground",
							lead && "mb-0.5",
							open && "bg-accent text-foreground",
							failed && "text-destructive",
						)}
					>
						<LuWrench className="size-3.5" />
					</button>
				</div>
				{open && (
					<div className="mt-1.5 rounded-lg border border-border bg-secondary/20 p-1.5">
						{group.map((item) => (
							<ToolRow key={item.id} item={item} />
						))}
					</div>
				)}
			</div>
		);
	},
	// The array is rebuilt every render; its rows only change by reference.
	(prev, next) =>
		sameLead(prev.lead, next.lead) &&
		prev.group.length === next.group.length &&
		prev.group.every((item, i) => item === next.group[i]),
);

interface ItemViewProps {
	item: Item;
	refs: Map<string, string>;
	workspaceId: string;
	paneId?: string;
	/** Changes only when a new ref appears - the memo's cue to re-link. */
	refsKey: string;
	onDo?: DoItem;
	/** Types a message into the session - the AWS sign-in retries with it. */
	onSend?: (text: string) => void;
	/** Runs a `! command` in the live session - set only while its PTY is up. */
	onRun?: (command: string) => Promise<void>;
	/** An older reply's, or one still being followed by output: only the final card shows. */
	hideActions?: boolean;
	/** The latest reply's TL;DR, once the brief has read this very reply. */
	tldr?: Tldr | null;
}

function sameItemView(prev: ItemViewProps, next: ItemViewProps): boolean {
	return (
		prev.item === next.item &&
		prev.refsKey === next.refsKey &&
		prev.workspaceId === next.workspaceId &&
		prev.paneId === next.paneId &&
		prev.onDo === next.onDo &&
		prev.onSend === next.onSend &&
		prev.onRun === next.onRun &&
		prev.hideActions === next.hideActions &&
		prev.tldr?.last === next.tldr?.last &&
		prev.tldr?.urgency === next.tldr?.urgency &&
		prev.tldr?.long === next.tldr?.long
	);
}

/** A lead is a fresh <ItemView> each render; compare it the way ItemView does. */
function sameLead(prev: ReactNode, next: ReactNode): boolean {
	return (
		prev === next ||
		(isValidElement(prev) &&
			isValidElement(next) &&
			prev.type === ItemView &&
			next.type === ItemView &&
			sameItemView(prev.props as ItemViewProps, next.props as ItemViewProps))
	);
}

const kTokens = (n: number) => `${Math.round(n / 1000)}k`;

/**
 * Where Claude compacted: one quiet line with what it saved. The summary it
 * continues from runs to pages, so it stays folded until you ask.
 */
function CompactRow({ item }: { item: Extract<Item, { kind: "compact" }> }) {
	const [open, setOpen] = useState(false);
	const stats = [
		item.preTokens && item.postTokens
			? `${kTokens(item.preTokens)} → ${kTokens(item.postTokens)} tokens`
			: null,
		item.durationMs ? `${Math.round(item.durationMs / 1000)}s` : null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className="my-3 flex flex-col">
			<button
				type="button"
				disabled={!item.summary}
				onClick={() => setOpen((value) => !value)}
				className="flex items-center gap-3 text-[11.5px] text-muted-foreground enabled:hover:text-foreground"
			>
				<span className="h-px flex-1 bg-border" />
				{item.summary && (
					<LuChevronRight
						className={cn(
							"size-3.5 shrink-0 transition-transform",
							open && "rotate-90",
						)}
					/>
				)}
				<span className="shrink-0">
					Conversation compacted{stats && ` · ${stats}`}
				</span>
				<span className="h-px flex-1 bg-border" />
			</button>
			{open && item.summary && (
				<div className="mt-2 max-h-[420px] select-text cursor-text overflow-y-auto rounded-lg border border-border bg-secondary/20 p-3">
					<MarkdownRenderer
						content={item.summary}
						style="default"
						allowHtml={false}
						className={COMPACT_MARKDOWN}
					/>
				</div>
			)}
		</div>
	);
}

/**
 * Output tokens across these items. Claude writes one line per block, each
 * carrying its message's running total, so the largest per message counts.
 */
export function outputTokens(items: Item[]): number {
	const byMessage = new Map<string, number>();
	for (const item of items)
		if ((item.kind === "text" || item.kind === "tool") && item.msg)
			byMessage.set(
				item.msg,
				Math.max(byMessage.get(item.msg) ?? 0, item.out ?? 0),
			);
	let total = 0;
	for (const out of byMessage.values()) total += out;
	return total;
}

/** "840", "2.1k", "12k". */
export function tokenLabel(n: number): string {
	if (n < 1000) return String(n);
	return n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/** Time since a moment, ticking: "42s", then "3m 05s", then "1h 02m". */
function Elapsed({ since }: { since: number }) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	return (
		<span className="shrink-0 tabular-nums text-muted-foreground">
			{elapsedLabel(now - since)}
		</span>
	);
}

export function elapsedLabel(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	const pad = (n: number) => String(n).padStart(2, "0");
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
	return `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`;
}

/** A row arriving while you watch: a short fade and rise, compositor-only. */
const ENTER = "animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out";

/**
 * Your message: a violet bubble on the right with room above it, so a reply
 * opens a new turn instead of reading as a line in Claude's text.
 */
function UserBubble({
	text,
	images,
	pending,
	lost,
	onShowTerminal,
	onDismiss,
	workspaceId,
}: {
	text: string;
	images?: Preview[];
	pending?: boolean;
	/** Never reached Claude - say so, with a way to see why. */
	lost?: boolean;
	onShowTerminal?: () => void;
	onDismiss?: () => void;
	workspaceId?: string;
}) {
	// A launch prompt (task + standing rules + reply format) fills the screen;
	// show just the request you typed, and Odin's part only on its own button.
	const request = launchRequest(text);
	const attached = useAttachedPreviews(
		request === null ? [] : launchAttachments(text),
		workspaceId,
	);
	const previews = [...(images ?? []), ...attached];
	const [open, setOpen] = useState(false);
	const [full, setFull] = useState(false);
	const shown = full || request === null ? text : request;
	const long = shown.length > 300 || shown.split("\n").length > 4;
	return (
		<div
			className={cn(
				"mt-5 mb-1 ml-auto max-w-[75%] select-text cursor-text break-words rounded-2xl rounded-br-md border border-primary/30 bg-primary/15 px-4 py-2.5 text-[13.5px] leading-relaxed text-foreground shadow-sm first:mt-0",
				pending && !lost && "opacity-60",
				pending && ENTER,
				lost && "border-danger/50",
			)}
		>
			{previews.length > 0 && (
				<PreviewStrip previews={previews} className={text ? "mb-2" : ""} />
			)}
			<div className={cn(long && !open && "line-clamp-3")}>
				{/* Typed line breaks stay: markdown would fold them into spaces. */}
				<MarkdownRenderer
					content={shown}
					style="default"
					allowHtml={false}
					className={cn(
						COMPACT_MARKDOWN,
						"text-[13.5px] text-foreground [&_li]:whitespace-pre-wrap [&_p]:whitespace-pre-wrap",
					)}
				/>
			</div>
			{(long || request !== null) && (
				<div className="mt-1 flex gap-3 text-[12px]">
					{long && (
						<button
							type="button"
							onClick={() => setOpen(!open)}
							className="text-link hover:underline"
						>
							{open ? "Show less" : "Show more"}
						</button>
					)}
					{request !== null && (
						<button
							type="button"
							onClick={() => setFull(!full)}
							className="text-link hover:underline"
						>
							{full ? "Hide Odin's prompt" : "Show Odin's prompt"}
						</button>
					)}
				</div>
			)}
			{lost && (
				<div className="mt-1.5 flex flex-wrap gap-x-3 text-[12px]">
					<span className="text-danger">
						Not delivered - Claude never took it
					</span>
					{onShowTerminal && (
						<button
							type="button"
							onClick={onShowTerminal}
							className="text-link hover:underline"
						>
							Show terminal
						</button>
					)}
					<button
						type="button"
						onClick={onDismiss}
						className="text-muted-foreground hover:text-foreground"
					>
						Dismiss
					</button>
				</div>
			)}
		</div>
	);
}

/**
 * The launch prompt's attached images and videos, read off disk as data URLs -
 * the folded bubble hides the paths, so these show what was attached.
 */
function useAttachedPreviews(
	paths: string[],
	workspaceId: string | undefined,
): Preview[] {
	const reads = electronTrpc.useQueries((t) =>
		workspaceId
			? paths.map((absolutePath) =>
					t.filesystem.readFile(
						{ workspaceId, absolutePath, encoding: "base64" },
						{ staleTime: Number.POSITIVE_INFINITY, retry: false },
					),
				)
			: [],
	);
	return paths.flatMap((path, i): Preview[] => {
		const content = reads[i]?.data?.content;
		if (typeof content !== "string") return [];
		const video = getVideoMimeType(path);
		return video
			? [{ url: `data:${video};base64,${content}`, video: true as const }]
			: [`data:${getImageMimeType(path)};base64,${content}`];
	});
}

/** The image and video paths under a launch prompt's "Attached files" head. */
export function launchAttachments(text: string): string[] {
	const block = text
		.split(/\n\n+/)
		.find((part) => part.startsWith("Attached files"));
	return (block?.split("\n").slice(1) ?? [])
		.map((line) => line.trim())
		.filter((path) => getImageMimeType(path) || isPreviewableVideoFile(path));
}

/** A pasted image or video: an image's URL alone, or a video with its file. */
type Preview = string | { url: string; video: true };

function PreviewStrip({
	previews,
	className,
	onRemove,
}: {
	previews: Preview[];
	className?: string;
	/** The composer's previews: each gets an × that drops it before sending. */
	onRemove?: (index: number) => void;
}) {
	// A click toggles one picture between thumbnail and a larger view.
	const [enlarged, setEnlarged] = useState<string | null>(null);
	return (
		<div className={cn("flex flex-wrap gap-2", className)}>
			{previews.map((preview, index) => (
				<div
					key={typeof preview === "string" ? preview : preview.url}
					className="relative"
				>
					{onRemove && (
						<button
							type="button"
							title="Remove"
							onClick={() => onRemove(index)}
							className="absolute -right-1.5 -top-1.5 z-10 flex size-5 items-center justify-center rounded-full border border-border bg-background text-[12px] leading-none text-muted-foreground hover:text-foreground"
						>
							×
						</button>
					)}
					{typeof preview === "string" ? (
						<button
							type="button"
							onClick={() =>
								setEnlarged((url) => (url === preview ? null : preview))
							}
							className={cn(
								"block",
								enlarged === preview ? "cursor-zoom-out" : "cursor-zoom-in",
							)}
						>
							<img
								src={preview}
								alt="Pasted"
								className={cn(
									"rounded-lg border border-border object-contain",
									enlarged === preview
										? "max-h-[60vh] max-w-full"
										: "max-h-40 max-w-60",
								)}
							/>
						</button>
					) : (
						<video
							src={preview.url}
							controls
							muted
							className="max-h-40 max-w-60 rounded-lg border border-border"
						/>
					)}
				</div>
			))}
		</div>
	);
}

/**
 * Odin's icon, on the first block of each reply - who's talking, at a glance.
 * Its own dark tile, brightened and ringed so the lines read on the drawer;
 * a violet screen-blend washed it out.
 */
function OdinMark({ className }: { className?: string }) {
	return (
		<img
			src={odinIcon}
			alt=""
			className={cn(
				"size-7 shrink-0 rounded-lg ring-1 ring-white/20 brightness-150 contrast-[1.15]",
				className,
			)}
		/>
	);
}

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

/**
 * The block heads useLaunchTaskSession and the rules store put after a task's
 * title and description: attachments, your context, standing rules, and the
 * closing instructions. Keep these in step with those writers.
 */
const LAUNCH_SCAFFOLD =
	/^(Attached files|Context and guidelines from me|This run was started by a schedule|Standing rules - follow each one|Work in the current workspace\.)/;

/**
 * The request you typed in a launch prompt - its title and description, without
 * the scaffolding the launcher added after them. null when there is none to fold.
 */
export function launchRequest(text: string): string | null {
	const blocks = text.split(/\n\n+/);
	const at = blocks.findIndex(
		(block, i) => i > 0 && LAUNCH_SCAFFOLD.test(block),
	);
	return at < 0 ? null : blocks.slice(0, at).join("\n\n");
}

/** An item that asks you to sign off - it gets an Approve button, "(you only)" or not. */
export function isApprovalItem(item: string): boolean {
	return /^\W*approve\b/i.test(item);
}

/** The latest reply that has an ACTION ITEMS block - the only one whose card shows. */
export function lastActionsId(items: Item[]): string | undefined {
	return items.findLast(
		(item) => item.kind === "text" && !!splitActionItems(item.text).actions,
	)?.id;
}

/** The numbered or bulleted lines of an ACTION ITEMS block; [] for "none". */
export const actionItemList = actionItemLines;

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
	// An option may hold a link ("after [#826](url) merges"); a button shows its words.
	// A trailing "(you only)" still counts: you pick, so the choices are buttons.
	const match = item.match(
		/\s*\[((?:[^[\]]|\[[^\]]*\]\([^)]*\))*\|(?:[^[\]]|\[[^\]]*\]\([^)]*\))*)\](?!\()\s*(?:\(you only\))?\W*$/i,
	);
	if (match?.index === undefined) return { text: item, options: [] };
	return {
		text: item.slice(0, match.index),
		options: (match[1] ?? "")
			.split("|")
			.map((option) => option.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim())
			.filter(Boolean),
	};
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
 * The paragraph of the reply that explains an item - the one sharing the most
 * of its words, and at least one name or two words. null when none does.
 */
export function itemDetail(item: string, body: string): string | null {
	const words = detailWords(itemOptions(item).text);
	let best: string | null = null;
	let top = 1;
	for (const block of body.split(/\n\s*\n/)) {
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

/**
 * What an item's button sends: the typed answer, "Done" for a "tell me when"
 * item, else nothing - and Claude is asked to do the item itself.
 */
export function itemReply(item: string, answer: string): string | undefined {
	const typed = answer.trim();
	if (typed) return typed;
	return !isApprovalItem(item) && isDoneItem(item) ? "Done" : undefined;
}

type DoItem = (
	item: string,
	number: number,
	approve: boolean,
	answer?: string,
) => void;

const ACTION_BUTTON =
	"shrink-0 rounded-md border border-attention/40 px-2 py-0.5 text-[11px] font-medium text-attention hover:bg-attention/15 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent";

/** Claude marks what it can't do "(you only)"; handing it back is a dead-end turn. */
export function isYouOnly(item: string): boolean {
	return (
		/\(you only\)\W*$/i.test(item) &&
		!isApprovalItem(item) &&
		!isAnswerItem(item) &&
		itemOptions(item).options.length === 0
	);
}

/** One action item: its button, number, text, and - for a question - the reply box and choices. */
function ActionItemRow({
	item,
	detail,
	number,
	onDo,
	onDismiss,
	buttonColumn,
	commands = [],
	onRun,
}: {
	item: string;
	/** The reply's paragraph about this item, shown on hover. */
	detail: string | null;
	number: number;
	onDo: DoItem;
	/** Hides the item now and in later replies; set when the session has a pane. */
	onDismiss?: () => void;
	/** Some item in the list has a button - line this one's number up with it. */
	buttonColumn: boolean;
	/** The reply's `!` commands, when this is the item that says to run them. */
	commands?: string[];
	onRun?: (command: string) => Promise<void>;
}) {
	const [sent, setSent] = useState(false);
	const [answer, setAnswer] = useState("");
	const { text, options } = itemOptions(item);
	const approve = isApprovalItem(item);
	const done = !approve && isDoneItem(item);
	const asks = !approve && (isAnswerItem(item) || options.length > 0);
	const send = (reply?: string) => {
		setSent(true);
		onDo(text, number, approve, reply);
	};
	return (
		<li
			className={cn(
				"group grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2",
				// No button column: number + text only, or the text lands in the 1rem cell.
				buttonColumn &&
					"grid-cols-[64px_1rem_minmax(0,1fr)_auto] @max-md:grid-cols-[1rem_minmax(0,1fr)_auto]",
			)}
		>
			{/* The button leads the row - you scan for it first. Too narrow (zoomed in), it drops under the text so the text keeps the width. */}
			{isYouOnly(item) ? (
				buttonColumn && <span className="@max-md:hidden" />
			) : (
				<button
					type="button"
					title={
						approve
							? "Tell Claude you approve and to go ahead"
							: asks && answer.trim()
								? "Send your answer to Claude"
								: done
									? "Tell Claude this is done"
									: "Ask Claude to do this for you"
					}
					disabled={sent}
					onClick={() => send(itemReply(item, answer))}
					className={cn(
						ACTION_BUTTON,
						"w-[64px] @max-md:col-start-2 @max-md:row-start-2",
					)}
				>
					{sent ? "Sent" : approve ? "Approve" : done ? "Done" : "Do it"}
				</button>
			)}
			<span className="pt-px text-right text-[13px] tabular-nums text-muted-foreground">
				{number}.
			</span>
			<div className="min-w-0 [overflow-wrap:anywhere]">
				<ItemDetail detail={detail}>
					<div className={cn(detail && "cursor-help")}>
						<MarkdownRenderer
							content={text}
							style="default"
							allowHtml={false}
							className={COMPACT_MARKDOWN}
						/>
					</div>
				</ItemDetail>
				{asks && !sent && (
					<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
						{options.map((option) => (
							<button
								key={option}
								type="button"
								title="Send this choice to Claude"
								onClick={() => send(option)}
								className={cn(ACTION_BUTTON, "max-w-full text-left")}
							>
								{option}
							</button>
						))}
						<input
							value={answer}
							onChange={(event) => setAnswer(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && answer.trim()) send(answer.trim());
							}}
							placeholder={options.length ? "Or type your own" : "Your answer"}
							className="min-w-[min(160px,100%)] flex-1 rounded-md border border-attention/30 bg-transparent px-2 py-0.5 text-[12px] outline-none placeholder:text-muted-foreground/70 focus:border-attention/60"
						/>
					</div>
				)}
				{onRun && <RunCommands commands={commands} onRun={onRun} />}
			</div>
			{onDismiss ? (
				<button
					type="button"
					title="Remove this item - Claude stops listing it"
					aria-label="Remove this item"
					onClick={onDismiss}
					className="px-1 text-[13px] leading-none text-muted-foreground/50 opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
				>
					×
				</button>
			) : (
				<span />
			)}
		</li>
	);
}

/** Hovering an item shows the reply's longer word on it; no detail, no tooltip. */
function ItemDetail({
	detail,
	children,
}: {
	detail: string | null;
	children: ReactElement;
}) {
	if (!detail) return children;
	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent
				side="bottom"
				align="start"
				className="max-h-[50vh] max-w-[420px] cursor-text select-text overflow-y-auto text-left"
			>
				<MarkdownRenderer
					content={detail}
					style="default"
					allowHtml={false}
					className={COMPACT_MARKDOWN}
				/>
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * What's on you, set apart in the board's Needs-you colour. Each item gets a
 * "Do it" button that hands it back to Claude (resuming an ended session
 * first), except the ones Claude marked "(you only)". An item asking you to
 * approve something gets "Approve" instead, which tells Claude to go ahead. An
 * item asking you to tell Claude something gets a reply box, plus a button per
 * choice when Claude listed them.
 */
function ActionItems({
	text,
	body = "",
	onDo,
	paneId,
	tldr,
	full = false,
	onToggle,
	commands = [],
	onRun,
}: {
	text: string;
	/** The reply's `!` commands: under the item that says to run them, else at the card's foot. */
	commands?: string[];
	onRun?: (command: string) => Promise<void>;
	/** The reply above the items, where each one's explanation is looked up. */
	body?: string;
	onDo?: DoItem;
	/** Where dismissed items are kept; no X without it. */
	paneId?: string;
	/** The latest reply's TL;DR, which leads this card instead of a box of its own. */
	tldr?: Tldr | null;
	full?: boolean;
	onToggle?: () => void;
}) {
	// text arrives linkified from ItemView.
	const dismissed = useDismissedActions(
		(s) => s.panes.find((pane) => pane.paneId === paneId)?.items,
	);
	const dismiss = useDismissedActions((s) => s.dismiss);
	// Numbered as Claude wrote them, so "action item 3" still means its 3.
	const items = (onDo ? actionItemList(text) : [])
		.map((item, index) => ({ item, number: index + 1 }))
		.filter(({ item }) => !isDismissed(dismissed ?? [], item));
	const buttonColumn = !items.every(({ item }) => isYouOnly(item));
	const runner = runItemIndex(items.map(({ item }) => item));
	return (
		<div
			data-action-items
			className="@container mt-2 rounded-xl border border-attention/35 bg-attention/[0.07] px-4 py-3"
		>
			<div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.08em] text-attention">
				Action items
				{tldr?.long && onToggle && (
					<FoldToggle full={full} onToggle={onToggle} />
				)}
			</div>
			{tldr && (
				<div
					data-testid="reply-tldr"
					className="mb-2 text-[13px] leading-relaxed text-foreground"
				>
					<span className="mr-1.5 text-[11px] font-semibold uppercase tracking-[.08em] text-muted-foreground">
						TL;DR
					</span>
					<TldrText text={tldr.last} />
				</div>
			)}
			{onDo && items.length === 0 && dismissed?.length ? (
				<div className="text-[13px] text-muted-foreground">None left.</div>
			) : onDo && items.length > 0 ? (
				<ol className="flex flex-col gap-1">
					{items.map(({ item, number }, index) => (
						<ActionItemRow
							key={number}
							item={item}
							detail={itemDetail(item, body)}
							number={number}
							onDo={onDo}
							onDismiss={paneId ? () => dismiss(paneId, item) : undefined}
							buttonColumn={buttonColumn}
							commands={commands}
							onRun={index === runner ? onRun : undefined}
						/>
					))}
				</ol>
			) : (
				<MarkdownRenderer
					content={text}
					style="default"
					allowHtml={false}
					className={COMPACT_MARKDOWN}
				/>
			)}
			{onRun && runner < 0 && <RunCommands commands={commands} onRun={onRun} />}
		</div>
	);
}

/**
 * The item a reply's `!` commands belong under: the first one that says to run
 * something ("Press Run on the blocks above"). -1 when none does.
 * ponytail: one word match; tie each block to its own item if replies mix several.
 */
export function runItemIndex(items: string[]): number {
	return items.findIndex((item) => /\brun\b/i.test(item));
}

function RunCommands({
	commands,
	onRun,
}: {
	commands: string[];
	onRun: (command: string) => Promise<void>;
}) {
	return commands.map((command) => (
		<RunCommand key={command} command={command} onRun={onRun} />
	));
}

/** The `! command` blocks Claude hands you to run in the session, without the `!`. */
export function bangCommands(text: string): string[] {
	return [...text.matchAll(/```[^\n]*\n\s*!([\s\S]*?)\n?```/g)]
		.map((match) => (match[1] ?? "").trim())
		.filter(Boolean);
}

/** Runs a `! command` in Claude's session, where its output comes back to Claude. */
function RunCommand({
	command,
	onRun,
}: {
	command: string;
	onRun: (command: string) => Promise<void>;
}) {
	const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
	return (
		<button
			type="button"
			disabled={state !== "idle"}
			onClick={() => {
				setState("sending");
				onRun(command).then(
					() => setState("sent"),
					(error) => {
						setState("idle");
						toast.error(error instanceof Error ? error.message : String(error));
					},
				);
			}}
			title={`Run in this session: ! ${command}`}
			className={cn(ACTION_BUTTON, "mt-2 flex max-w-full items-center gap-1.5")}
		>
			<LuSquareTerminal className="size-3.5 shrink-0" />
			<span className="truncate font-mono">
				{state === "sent" ? "Sent" : "Run"} ! {command.split("\n")[0]}
			</span>
		</button>
	);
}

/** Claude on Bedrock stops on an expired AWS SSO token and says to run this. */
export function needsAwsSsoLogin(text: string): boolean {
	return /run 'aws sso login'/i.test(text);
}

/** Runs `aws sso login` for the user, then tells Claude to try again. */
function AwsSsoLogin({ onSend }: { onSend: (text: string) => void }) {
	const login = electronTrpc.terminal.awsSsoLogin.useMutation({
		onSuccess: () =>
			onSend("I signed in to AWS again (aws sso login). Retry what failed."),
		onError: (error) => toast.error(`aws sso login failed: ${error.message}`),
	});
	return (
		<button
			type="button"
			disabled={login.isPending || login.isSuccess}
			onClick={() => login.mutate()}
			title="Run aws sso login - approve it in the browser tab that opens - then Claude retries"
			className={cn(ACTION_BUTTON, "mt-2")}
		>
			{login.isSuccess
				? "Signed in - Claude is retrying"
				: login.isPending
					? "Approve in your browser…"
					: "Sign in to AWS and retry"}
		</button>
	);
}

type Tldr = NonNullable<ReturnType<typeof freshTldr>>;

/** A long reply cut to its first lines, fading out, until you ask for all of it. */
function FoldedReply({
	folded,
	children,
}: {
	folded: boolean;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				folded &&
					"max-h-[6.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
			)}
		>
			{children}
		</div>
	);
}

/** Switches a long latest reply between folded on its TL;DR and shown whole. */
function FoldToggle({
	full,
	onToggle,
}: {
	full: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			className="ml-auto text-[12px] font-normal normal-case tracking-normal text-link hover:underline"
		>
			{full ? "Show TL;DR" : "Show full reply"}
		</button>
	);
}

/**
 * The latest reply in a few lines, and whether it wants something from you.
 * A long reply opens folded on this; the button switches between the two.
 */
/** A TL;DR line rendered as Markdown (`code`, **bold**, links) that flows after its inline label. */
function TldrText({ text }: { text: string }) {
	return (
		<MarkdownRenderer
			content={text}
			style="default"
			allowHtml={false}
			className={cn(
				COMPACT_MARKDOWN,
				"inline! text-foreground [&_article]:inline! [&_p]:inline!",
			)}
		/>
	);
}

function TldrCard({
	tldr,
	full,
	onToggle,
}: {
	tldr: Tldr;
	full: boolean;
	onToggle: () => void;
}) {
	const needsYou = tldr.urgency === "needs-you";
	return (
		<div
			data-testid="reply-tldr"
			className={cn(
				"mt-2 rounded-xl border px-4 py-2.5",
				needsYou
					? "border-attention/35 bg-attention/[0.07]"
					: "border-border bg-secondary/30",
			)}
		>
			<div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.08em] text-muted-foreground">
				TL;DR
				{tldr.urgency && (
					<span
						className={cn(
							"rounded-full px-1.5 py-px text-[10px] tracking-[.04em]",
							needsYou
								? "bg-attention/15 text-attention"
								: "bg-secondary text-muted-foreground",
						)}
					>
						{needsYou ? "Needs you" : "FYI"}
					</span>
				)}
				{tldr.long && <FoldToggle full={full} onToggle={onToggle} />}
			</div>
			<div className="text-[13px] leading-relaxed text-foreground">
				<TldrText text={tldr.last} />
			</div>
		</div>
	);
}

const ItemView = memo(function ItemView({
	item,
	refs,
	onDo,
	onSend,
	onRun,
	workspaceId,
	paneId,
	hideActions = false,
	tldr,
}: ItemViewProps) {
	// A long latest reply opens on its TL;DR; this shows it whole.
	const [full, setFull] = useState(false);
	if (item.kind === "tool") return <ToolRow item={item} />;
	if (item.kind === "compact") return <CompactRow item={item} />;
	if (item.kind === "user")
		return (
			<UserBubble
				text={item.text}
				images={item.images}
				workspaceId={workspaceId}
			/>
		);
	const { body, actions } = splitActionItems(linkify(item.text, refs));
	const showsActions = !!actions && !hideActions;
	const commands = onRun ? bangCommands(item.text) : [];
	const placement = tldrPlacement(tldr, showsActions);
	const toggleFull = () => setFull((value) => !value);
	return (
		<div className="select-text cursor-text">
			{body && (
				<FoldedReply folded={!!tldr?.long && !full}>
					<MarkdownRenderer
						content={body}
						style="default"
						allowHtml={false}
						className={COMPACT_MARKDOWN}
					/>
				</FoldedReply>
			)}
			{placement === "card" && tldr && (
				<TldrCard tldr={tldr} full={full} onToggle={toggleFull} />
			)}
			{showsActions && (
				<ActionItems
					text={actions}
					body={body}
					onDo={onDo}
					paneId={paneId}
					tldr={placement === "action-items" ? tldr : null}
					full={full}
					onToggle={toggleFull}
					commands={commands}
					onRun={onRun}
				/>
			)}
			{onSend && needsAwsSsoLogin(item.text) && <AwsSsoLogin onSend={onSend} />}
			{onRun && !showsActions && (
				<RunCommands commands={commands} onRun={onRun} />
			)}
		</div>
	);
}, sameItemView);

/**
 * A live session as Claude Code looks in the Claude desktop app: prose,
 * collapsible tool rows, and a composer. Claude keeps running in its terminal
 * behind it - this types into the same PTY.
 */
export function ChatView({
	paneId,
	sessionId,
	cwd,
	workspaceId,
	working = false,
	onShowTerminal,
	onStop,
	onResumeWith,
	onSend,
	noTerminal = false,
	placeholder,
	onOpenSession,
	resuming = false,
	tldrOnly = false,
}: {
	paneId: string;
	sessionId: string | null;
	cwd: string | undefined;
	workspaceId: string;
	working?: boolean;
	/** Omitted for an ended session: its composer resumes via `onResumeWith`. */
	onShowTerminal?: () => void;
	/** Interrupt the turn - the drawer's Interrupt, so the card leaves Working too. */
	onStop?: () => void;
	/** Ended session: resume it with this as the opening message. */
	onResumeWith?: (text: string) => void;
	/** Sends a reply in place of typing it into the PTY - the raven's, which brings a dead PTY back first. */
	onSend?: (text: string) => void;
	/** Hide the links to the terminal view (the crow's panel has none). */
	noTerminal?: boolean;
	/** The reply box's prompt, in place of "Reply to Claude". */
	placeholder?: string;
	/** Follows a `#session=<paneId>` link in a reply (the raven writes them). */
	onOpenSession?: (paneId: string) => void;
	/** Ended session on its way back: the footer says so in place of the composer. */
	resuming?: boolean;
	/** Every reply folds on its TL;DR, with no Needs you / FYI mark - the raven's panel. */
	tldrOnly?: boolean;
}) {
	const { data: home } = electronTrpc.window.getHomeDir.useQuery();
	// Claude files the conversation under the directory it STARTED in - the
	// transcript's first cwd. The pane's cwd has often moved on since (a feed
	// session starts in ~/dev and works in a worktree). Same query and options
	// as the card's pills, so it's a cache hit; the pane's cwd is the fallback.
	const { data: transcript, isError } =
		electronTrpc.terminal.readClaudeTranscript.useQuery(
			{ sessionId: sessionId ?? "" },
			{ enabled: !!sessionId, retry: false, staleTime: 60_000 },
		);
	// Wait for the answer: guessing with the pane's cwd first flashed "Not on
	// disk yet" at a wrong path. The pane's cwd only stands in when there's no
	// transcript to ask (not written yet, or unreadable).
	const startCwd = transcript ? (transcript.cwd ?? cwd) : isError ? cwd : null;
	const path =
		home && startCwd && sessionId
			? transcriptPath(home, startCwd, sessionId)
			: null;
	const {
		items,
		queued,
		missing,
		poke,
		hasEarlier,
		earlierLoads,
		loadEarlier,
	} = useLiveItems(path, workspaceId);
	// The whole view takes a file drop, not just the reply box: a drop on the
	// conversation used to do nothing. The composer owns the attachments.
	const dropRef = useRef<(files: File[]) => void>(undefined);
	const [dragging, setDragging] = useState(false);
	// PR and ticket refs this session has URLs for, so "#676" can link.
	const refs = useMemo(
		() =>
			collectRefs(
				items.map((item) =>
					item.kind === "tool"
						? `${JSON.stringify(item.input)} ${(item.result ?? "").slice(0, 20_000)}`
						: item.kind === "compact"
							? ""
							: item.text,
				),
			),
		[items],
	);
	const refsKey = [...refs.keys()].join(" ");
	const write = electronTrpc.terminal.write.useMutation();
	// A menu answer is a few keys in a row; each needs the TUI to have redrawn
	// before the next lands.
	const sendKeys = async (keys: string[]) => {
		try {
			for (const key of keys) {
				await write.mutateAsync({ paneId, data: key });
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
		for (const ms of [300, 1000, 2500]) setTimeout(poke, ms);
		void screen.refetch();
	};
	const prompt = onShowTerminal ? asking(items) : null;
	// The turn began with your last message; "Working..." counts from it, and
	// opens to every command Claude has run since.
	const turnIndex = items.findLastIndex(
		(item) => item.kind === "user" && item.at !== undefined,
	);
	const turnStart =
		turnIndex >= 0
			? (items[turnIndex] as Extract<Item, { kind: "user" }>).at
			: undefined;
	const turnTools = items
		.slice(turnIndex + 1)
		.filter((item): item is Tool => item.kind === "tool");
	const turnTokens = outputTokens(items.slice(turnIndex + 1));
	const [showCommands, setShowCommands] = useState(false);
	// Menus the transcript never sees, read off the live screen.
	const screen = electronTrpc.terminal.readScreen.useQuery(
		{ paneId },
		{ enabled: !!onShowTerminal && !prompt, refetchInterval: POLL_MS },
	);
	const screenText = onShowTerminal && !prompt ? screen.data?.text : null;
	const screenMenu = useMemo(
		() => (screenText ? parseScreenMenu(screenText) : null),
		[screenText],
	);
	const screenAside = useMemo(
		() => (screenText ? parseScreenAside(screenText) : null),
		[screenText],
	);
	// What you just sent, shown at once - Claude writes it to the transcript a
	// beat later, and that echo replaces it.
	const [pending, setPending] = useState<Sent[]>(
		() => carried.get(paneId) ?? [],
	);
	useEffect(() => {
		if (pending.length) carried.set(paneId, pending);
		else carried.delete(paneId);
	}, [paneId, pending]);
	useEffect(() => {
		setPending((list) => list.filter((sent) => !isEchoed(items, sent)));
	}, [items]);
	// ponytail: an echo that never matches (Claude rewrote it) just expires.
	// Not mid-turn or queued: Claude writes a queued message only when it takes it.
	const expireLater = (id: number, text: string) => {
		const expire = () =>
			workingRef.current ||
			yourQueued(queuedRef.current).some((queuedText) =>
				queuedText.includes(text),
			)
				? setTimeout(expire, 30_000)
				: setPending((list) =>
						list.filter((sent) => sent.id !== id || sent.lost),
					);
		setTimeout(expire, 30_000);
	};
	// Carried in from the view that sent them: its timers died with it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
	useEffect(() => {
		for (const sent of carried.get(paneId) ?? [])
			expireLater(sent.id, sent.text);
	}, []);
	const onSent = (text: string, previews?: Preview[]) => {
		const id = Date.now();
		pinnedRef.current = true;
		// A /btw never reaches the transcript - its answer card shows it instead,
		// and a bubble waiting on an echo would read "Not delivered".
		if (/^\/btw\s/.test(text)) return;
		const seen = new Set(
			itemsRef.current.flatMap((item) =>
				item.kind === "user" ? [item.id] : [],
			),
		);
		setPending((list) => [...list, { id, text, previews, seen }]);
		// Claude takes a moment to write it; look again a few times meanwhile.
		for (const ms of [150, 500, 1000]) setTimeout(poke, ms);
		// Claude logs a message the moment it takes it, as a turn or queued
		// mid-turn. Nothing by now: it never got there, and the bubble says so
		// instead of waiting on a turn that isn't coming. Not for `onSend` or a
		// resume, which bring a dead PTY back first, or before a transcript loaded.
		if (!onSend && !onResumeRef.current)
			setTimeout(() => {
				if (itemsRef.current.length === 0) return;
				setPending((list) =>
					list.map((sent) =>
						sent.id === id &&
						!arrived(itemsRef.current, queuedRef.current, sent)
							? { ...sent, lost: true }
							: sent,
					),
				);
			}, 10_000);
		expireLater(id, text);
	};
	const itemsRef = useRef(items);
	itemsRef.current = items;
	const queuedRef = useRef(queued);
	queuedRef.current = queued;
	const workingRef = useRef(working);
	workingRef.current = working;
	const onSentRef = useRef(onSent);
	onSentRef.current = onSent;
	// Stable, so the memoized rows don't all re-render on every poll.
	// A ref, so a fresh arrow from the drawer doesn't re-render every message.
	const onResumeRef = useRef(onResumeWith);
	onResumeRef.current = onResumeWith;
	const sendToClaude = useCallback(
		(message: string) => {
			const text = withDismissals(paneId, message);
			if (onResumeRef.current) {
				onSentRef.current(text);
				onResumeRef.current(text);
				return;
			}
			onSentRef.current(text);
			void typeIntoClaude(write.mutateAsync, paneId, text).catch((error) =>
				toast.error(error instanceof Error ? error.message : String(error)),
			);
		},
		[paneId, write.mutateAsync],
	);
	// "!" alone first: it switches Claude's prompt to bash mode, which a paste can't.
	const runInClaude = useCallback(
		async (command: string) => {
			await write.mutateAsync({ paneId, data: "!" });
			await new Promise((resolve) => setTimeout(resolve, 50));
			await typeIntoClaude(write.mutateAsync, paneId, command);
		},
		[paneId, write.mutateAsync],
	);
	const doItem = useCallback(
		(item: string, number: number, approve: boolean, answer?: string) => {
			sendToClaude(
				approve
					? `Approved - go ahead with action item ${number}: ${item}`
					: answer !== undefined
						? `Action item ${number} (${item}): ${answer}`
						: `Do action item ${number} for me: ${item}`,
			);
		},
		[sendToClaude],
	);
	const lastText = items.findLast(
		(item): item is Extract<Item, { kind: "text" }> => item.kind === "text",
	);
	const lastTextId = lastText?.id;
	// The brief's TL;DR of the latest reply. Asked for once the turn is over -
	// mid-turn the latest reply is a moving target - and shown only while the
	// brief read this very reply: a newer one makes it a wrong TL;DR, so the
	// card waits for the brief that catches up.
	const { data: brief } = electronTrpc.terminal.summarizeClaudeSession.useQuery(
		{ sessionId: sessionId ?? "", settled: true },
		{
			enabled: !!sessionId && !!lastText && !working,
			retry: false,
			staleTime: 30_000,
			refetchInterval: (query) =>
				sameReply(lastText?.at, query.state.data?.replyAt) ? false : 15_000,
		},
	);
	// Measured without its ACTION ITEMS: those show in their own card.
	const fresh = working
		? null
		: freshTldr(
				lastText && { ...lastText, text: splitActionItems(lastText.text).body },
				brief,
			);
	// A short reply reads faster than its TL;DR, so it gets none.
	const tldr =
		fresh && tldrOnly
			? { ...fresh, urgency: null, long: true }
			: fresh?.long
				? fresh
				: null;
	// Agents repeat their ACTION ITEMS in every reply; show one card, on the
	// latest reply that has it. It stays while Claude works on your answer.
	const actionsId = lastActionsId(items);
	const scrollRef = useRef<HTMLDivElement>(null);
	const pinnedRef = useRef(true);
	const lastScrollTopRef = useRef(0);
	// What was already there when the drawer opened shows still; only rows
	// that arrive after it animate in.
	const firstIdsRef = useRef<Set<string> | null>(null);
	if (firstIdsRef.current === null && items.length > 0)
		firstIdsRef.current = new Set(items.map((item) => item.id));
	// Follow new output only while you're at the bottom - scrolling up to read
	// shouldn't get yanked back every second.
	// biome-ignore lint/correctness/useExhaustiveDependencies: items/pending are the trigger - new rows change scrollHeight
	useEffect(() => {
		const el = scrollRef.current;
		if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
	}, [items, pending]);
	// Earlier rows land above what you're reading: keep it where it was, and
	// don't animate them in.
	const fromBottomRef = useRef<number | null>(null);
	const fetchEarlier = () => {
		const el = scrollRef.current;
		if (!el || !hasEarlier || fromBottomRef.current !== null) return;
		fromBottomRef.current = el.scrollHeight - el.scrollTop;
		void loadEarlier().then((loaded) => {
			if (!loaded) fromBottomRef.current = null;
		});
	};
	// A window too short to scroll gives no scroll to load more on.
	// biome-ignore lint/correctness/useExhaustiveDependencies: items is the trigger - rows change scrollHeight
	useEffect(() => {
		const el = scrollRef.current;
		if (el && el.scrollHeight <= el.clientHeight) fetchEarlier();
	}, [items, hasEarlier]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: earlierLoads is the trigger - it bumps with the prepended rows
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el || fromBottomRef.current === null) return;
		el.scrollTop = el.scrollHeight - fromBottomRef.current;
		fromBottomRef.current = null;
		for (const item of items) firstIdsRef.current?.add(item.id);
	}, [earlierLoads]);
	// Rows also grow after they mount (code blocks, images, markdown), so a
	// switched-to session would stop short of the bottom; follow that too.
	const contentRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = scrollRef.current;
		const content = contentRef.current;
		if (!el || !content) return;
		const observer = new ResizeObserver(() => {
			if (pinnedRef.current) el.scrollTop = el.scrollHeight;
		});
		observer.observe(content);
		return () => observer.disconnect();
	}, []);
	// A live session whose first prompt hasn't reached the transcript yet: the
	// file doesn't exist ("Not on disk yet") or holds no turn so far.
	// Claude's PreCompact hook marked the start; the boundary it writes when
	// done ends it.
	const compactStart = useCompacting((state) => state.since[paneId]);
	const compacting =
		compactStart !== undefined &&
		!items.some(
			(item) => item.kind === "compact" && (item.at ?? 0) >= compactStart,
		)
			? compactStart
			: null;
	const starting =
		!!onShowTerminal &&
		!screenMenu &&
		items.length === 0 &&
		pending.length === 0 &&
		yourQueued(queued).length === 0 &&
		(!missing || missing.startsWith("Not on disk yet"));
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Page Up/Down from the composer jump the conversation to its top/bottom; a file dropped anywhere on it attaches
		<div
			className="flex min-h-0 flex-1 flex-col"
			onDragOver={(event) => {
				if (!dropRef.current || !event.dataTransfer.types.includes("Files"))
					return;
				event.preventDefault();
				setDragging(true);
			}}
			onDragLeave={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node))
					setDragging(false);
			}}
			onDrop={(event) => {
				if (!dropRef.current || !event.dataTransfer.types.includes("Files"))
					return;
				// Stop Electron from opening a dropped file in the window.
				event.preventDefault();
				setDragging(false);
				dropRef.current([...event.dataTransfer.files]);
			}}
			onKeyDown={(event) => {
				const el = scrollRef.current;
				const top = isHotkey("CHAT_TO_TOP", event.nativeEvent);
				if (!el || (!top && !isHotkey("CHAT_TO_BOTTOM", event.nativeEvent)))
					return;
				event.preventDefault();
				el.scrollTop = top ? 0 : el.scrollHeight;
			}}
		>
			<div
				ref={scrollRef}
				onScroll={(event) => {
					const el = event.currentTarget;
					// Only scrolling up lets go of the bottom. Rows that grow, shrink
					// or swap (your message's echo) move scrollTop too, and used to
					// unpin it right after a send.
					const up = el.scrollTop < lastScrollTopRef.current;
					lastScrollTopRef.current = el.scrollTop;
					const atBottom =
						el.scrollHeight - el.scrollTop - el.clientHeight < 80;
					if (atBottom || up) pinnedRef.current = atBottom;
					if (el.scrollTop < el.clientHeight) fetchEarlier();
				}}
				// Links open in Odin's browser, like everywhere else on the board.
				onClickCapture={(event) => {
					const anchor = (event.target as HTMLElement).closest("a");
					const session = anchor
						?.getAttribute("href")
						?.match(/^#session=(.+)$/)?.[1];
					if (session && onOpenSession) {
						event.preventDefault();
						onOpenSession(decodeURIComponent(session));
					} else if (anchor?.href.startsWith("http")) {
						event.preventDefault();
						openUrl(anchor.href);
					}
				}}
				className="min-h-0 flex-1 overflow-y-auto px-8 py-6"
			>
				<div ref={contentRef} className="flex flex-col gap-2.5">
					{starting ? (
						<div className="flex items-center gap-3 text-[12.5px] text-working">
							<OdinMark className="animate-[odin-nod_1.6s_ease-in-out_infinite]" />
							Starting session…
							{/* Before its first turn the CLI can stop on a terminal-only
							    prompt (folder trust, bypass-permissions warning) that no
							    transcript ever shows. */}
							{!noTerminal && (
								<button
									type="button"
									onClick={onShowTerminal}
									className="text-[11.5px] text-muted-foreground hover:text-foreground"
								>
									Stuck? Show terminal
								</button>
							)}
						</div>
					) : (
						missing &&
						items.length === 0 && (
							<div className="select-text cursor-text text-[12px] text-muted-foreground">
								{missing}
							</div>
						)
					)}
					{segments(items).map((segment, index, all) => {
						const previous = all[index - 1];
						const following = all[index + 1];
						// A run's toggle sits at the end of the line before it.
						if (
							Array.isArray(segment) &&
							!Array.isArray(previous) &&
							previous?.kind === "text"
						)
							return null;
						// A reply starts after your message (or at the top); its first
						// block carries Claude's mark, the rest line up beside it.
						const opensReply =
							!(!Array.isArray(segment) && segment.kind === "user") &&
							(index === 0 ||
								(!Array.isArray(previous) &&
									(previous?.kind === "user" || previous?.kind === "compact")));
						if (
							!Array.isArray(segment) &&
							(segment.kind === "user" || segment.kind === "compact")
						)
							return (
								<ItemView
									key={segment.id}
									item={segment}
									refs={refs}
									refsKey={refsKey}
									workspaceId={workspaceId}
								/>
							);
						const key = Array.isArray(segment) ? segment[0]?.id : segment.id;
						const itemView = !Array.isArray(segment) && (
							<ItemView
								item={segment}
								refs={refs}
								refsKey={refsKey}
								workspaceId={workspaceId}
								paneId={paneId}
								onDo={onShowTerminal || onResumeWith ? doItem : undefined}
								hideActions={segment.id !== actionsId}
								tldr={segment.id === lastTextId ? tldr : null}
								onRun={
									// Only a live PTY runs a ! command; a resume or the raven's send can't.
									onShowTerminal && !onSend ? runInClaude : undefined
								}
								onSend={
									// Only the latest reply: an old expired-token error is fixed.
									(onShowTerminal || onResumeWith) && segment.id === lastTextId
										? sendToClaude
										: undefined
								}
							/>
						);
						return (
							<div
								key={key}
								className={cn(
									"flex min-w-0 gap-3",
									key && !firstIdsRef.current?.has(key) && ENTER,
								)}
							>
								{opensReply ? <OdinMark /> : <span className="w-7 shrink-0" />}
								<div className="min-w-0 flex-1">
									{Array.isArray(segment) ? (
										<ToolGroup group={segment} />
									) : Array.isArray(following) ? (
										<ToolGroup group={following} lead={itemView} />
									) : (
										itemView
									)}
								</div>
							</div>
						);
					})}
					{pending.map((sent) => (
						<UserBubble
							key={sent.id}
							text={sent.text}
							images={sent.previews}
							pending
							lost={sent.lost}
							onShowTerminal={onShowTerminal}
							onDismiss={() =>
								setPending((list) =>
									list.filter((other) => other.id !== sent.id),
								)
							}
						/>
					))}
					{yourQueued(queued)
						.filter((text) => !pending.some((sent) => text.includes(sent.text)))
						.map((text, index) => (
							<UserBubble
								// biome-ignore lint/suspicious/noArrayIndexKey: the same text can be queued twice
								key={`queued-${index}`}
								text={text}
								pending
							/>
						))}
					{prompt && (
						<div className={cn("flex min-w-0 gap-3", ENTER)}>
							<OdinMark />
							<div className="min-w-0 flex-1">
								{prompt.name === "AskUserQuestion" ? (
									<QuestionCard
										key={prompt.id}
										input={prompt.input}
										onKeys={sendKeys}
									/>
								) : (
									<PlanCard
										key={prompt.id}
										input={prompt.input}
										onKeys={sendKeys}
									/>
								)}
								{!noTerminal && (
									<button
										type="button"
										onClick={onShowTerminal}
										className="mt-1.5 text-[11.5px] text-muted-foreground hover:text-foreground"
									>
										Answer in Terminal View instead
									</button>
								)}
							</div>
						</div>
					)}
					{screenMenu && (
						<div className={cn("flex min-w-0 gap-3", ENTER)}>
							<OdinMark />
							<div className="min-w-0 flex-1">
								<ScreenMenuCard
									key={`${screenMenu.title}\n${screenMenu.options.join("\n")}`}
									menu={screenMenu}
									onKeys={sendKeys}
								/>
								{!noTerminal && (
									<button
										type="button"
										onClick={onShowTerminal}
										className="mt-1.5 text-[11.5px] text-muted-foreground hover:text-foreground"
									>
										Answer in Terminal View instead
									</button>
								)}
							</div>
						</div>
					)}
					{screenAside && (
						<div className={cn("flex min-w-0 gap-3", ENTER)}>
							<OdinMark />
							<div className="min-w-0 flex-1">
								<ScreenAsideCard
									aside={screenAside}
									onClose={() => void sendKeys(["\x1b"])}
								/>
							</div>
						</div>
					)}
					{working && !prompt && !screenMenu && !screenAside && !starting && (
						<div className="flex min-w-0 gap-3 text-[12.5px] text-working">
							{/* Odin's icon, nodding along while Claude works. */}
							<OdinMark className="animate-[odin-nod_1.6s_ease-in-out_infinite]" />
							{compacting === null ? (
								<div className="flex min-w-0 flex-1 flex-col">
									<button
										type="button"
										title={
											showCommands
												? "Hide the steps"
												: "Show what Claude did this turn"
										}
										disabled={turnTools.length === 0}
										onClick={() => setShowCommands(!showCommands)}
										className="flex h-7 items-center gap-3 self-start rounded-md enabled:hover:text-foreground"
									>
										<span className="shrink-0">Working…</span>
										{turnStart !== undefined && <Elapsed since={turnStart} />}
										{turnTokens > 0 && (
											<span
												title="Tokens Claude has written this turn"
												className="shrink-0 tabular-nums text-muted-foreground"
											>
												↓ {tokenLabel(turnTokens)} tokens
											</span>
										)}
										{turnTools.length > 0 && (
											<LuChevronRight
												className={cn(
													"size-3.5 shrink-0 text-muted-foreground transition-transform",
													showCommands && "rotate-90",
												)}
											/>
										)}
									</button>
									{showCommands && turnTools.length > 0 && (
										// Same rows as a finished turn's Worked list: what each
										// step did, opening to its command and output.
										<div className="mt-1.5 max-h-[420px] overflow-y-auto rounded-lg border border-border bg-secondary/20 p-1.5 text-foreground">
											{turnTools.map((tool) => (
												<ToolRow key={tool.id} item={tool} />
											))}
										</div>
									)}
								</div>
							) : (
								<div className="flex h-7 items-center gap-3">
									Compacting conversation…
									<Elapsed since={compacting} />
								</div>
							)}
						</div>
					)}
				</div>
			</div>
			{onShowTerminal ? (
				<>
					{/* While a menu or /btw waits, typed text would land in it - the card answers. */}
					{!prompt && !screenMenu && !screenAside && (
						<Composer
							paneId={paneId}
							working={working}
							onSent={onSent}
							onStop={onStop}
							onSend={onSend}
							noTerminal={noTerminal}
							placeholder={placeholder}
							dropRef={dropRef}
							dragging={dragging}
						/>
					)}
				</>
			) : onResumeWith ? (
				// Ended session: the first message resumes it.
				<Composer
					paneId={paneId}
					working={false}
					onSent={onSent}
					noTerminal={noTerminal}
					onResume={onResumeWith}
					placeholder="Reply to resume the session"
					dropRef={dropRef}
					dragging={dragging}
				/>
			) : (
				<div className="border-t border-border px-5 py-2 text-center text-[11.5px] text-muted-foreground">
					{resuming ? "Resuming session…" : "Session ended - Resume to reply"}
				</div>
			)}
		</div>
	);
}

/**
 * Types a message into Claude's PTY and submits it. Text goes in as a
 * bracketed paste when it spans lines (a bare newline would submit early),
 * then Enter in its own write. `now` submits with Claude's send-now chord
 * (Ctrl+X Ctrl+S) instead: mid-turn it lands right away, not after the turn.
 * Ctrl+Enter itself can't cross a PTY - it arrives as a plain Enter.
 */
export async function typeIntoClaude(
	write: (input: { paneId: string; data: string }) => Promise<unknown>,
	paneId: string,
	text: string,
	now = false,
) {
	if (text)
		await write({
			paneId,
			data: text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text,
		});
	await new Promise((resolve) => setTimeout(resolve, 30));
	await write({ paneId, data: now ? "\x18\x13" : "\r" });
}

/**
 * Stops Claude's turn with Ctrl+C. Not Esc: with a message queued, Esc only
 * pulls the queue back into Claude's input box and the turn runs on. And not
 * when Claude already sits at its prompt - a hook can leave the card on
 * Working - because there Ctrl+C stops every background agent the session
 * runs, and a second one quits Claude. Two reads must agree it's idle: a
 * snapshot caught mid-repaint can lack the spinner. Returns whether it sent it.
 */
export async function interruptClaude(
	write: (input: { paneId: string; data: string }) => Promise<unknown>,
	readScreen: (input: { paneId: string }) => Promise<{ text: string | null }>,
	paneId: string,
): Promise<boolean> {
	const atPrompt = async () => {
		const { text } = await readScreen({ paneId }).catch(() => ({
			text: null,
		}));
		return !!text && odinScreenStatus(text) === "review";
	};
	if (await atPrompt()) {
		await new Promise((resolve) => setTimeout(resolve, 300));
		if (await atPrompt()) return false;
	}
	await write({ paneId, data: "\x03" });
	// Stopped before it answered, Claude puts your message back in its input
	// box, and the next one sent from here would land after it: "test" then
	// "test" went in as "testtest". Clear it: Ctrl+U empties a row, Backspace
	// joins the row above.
	await new Promise((resolve) => setTimeout(resolve, 500));
	const { text } = await readScreen({ paneId }).catch(() => ({ text: null }));
	const rows = text ? inputBoxRows(text) : 0;
	if (rows > 0) await write({ paneId, data: `${"\x15\x7f".repeat(rows)}\x15` });
	return true;
}

/**
 * Its own component so a keystroke re-renders the box, not the conversation.
 * A pasted or dropped image or video is saved and held as a preview with its
 * path until you send, so its × can still drop it. Sending pastes each path
 * into Claude's prompt, where an image path turns into an [Image #N]
 * attachment and a video stays a path (Claude takes no video). Any other
 * file goes into the draft as its path, as the terminal does with a drop.
 */
function Composer({
	paneId,
	working,
	onSent,
	onStop,
	noTerminal,
	placeholder = "Reply to Claude",
	onResume,
	onSend,
	dropRef,
	dragging,
}: {
	paneId: string;
	working: boolean;
	onSent: (text: string, previews?: Preview[]) => void;
	onStop?: () => void;
	noTerminal: boolean;
	placeholder?: string;
	/** Ended session: sending resumes it with the text instead of typing into a PTY. */
	onResume?: (text: string) => void;
	/** Sends in place of typing into the PTY; the sent bubble still shows. */
	onSend?: (text: string) => void;
	/** The view's drop zone hands dropped files here. */
	dropRef: { current?: (files: File[]) => void };
	dragging: boolean;
}) {
	const [draft, setDraft] = useState(() => draftFor(paneId));
	useEffect(
		() => useChatDrafts.getState().save(paneId, draft),
		[paneId, draft],
	);
	// "!" on an empty box switches to bash mode, like the terminal's prompt.
	const [bash, setBash] = useState(false);
	const [attached, setAttached] = useState<
		{ preview: Preview; path: string }[]
	>([]);
	const attach = (files: File[], cite = false) => {
		const media = files.filter(
			(f) => f.type.startsWith("image/") || f.type.startsWith("video/"),
		);
		const others = cite
			? files
					.filter((f) => !media.includes(f))
					.map((f) => window.webUtils.getPathForFile(f))
					.filter(Boolean)
			: [];
		if (others.length > 0) {
			const text = shellEscapePaths(others);
			setDraft((d) => (d && !/\s$/.test(d) ? `${d} ${text}` : d + text));
			inputRef.current?.focus();
		}
		if (media.length === 0) return others.length > 0;
		void attachmentPaths(media).then(
			(paths) =>
				setAttached((list) => [
					...list,
					...media.map((file, index) => ({
						path: paths[index] ?? "",
						preview: file.type.startsWith("video/")
							? { url: URL.createObjectURL(file), video: true as const }
							: URL.createObjectURL(file),
					})),
				]),
			(error) => toast.error(String(error)),
		);
		return true;
	};
	dropRef.current = (files) => attach(files, true);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const write = electronTrpc.terminal.write.useMutation();
	const utils = electronTrpc.useUtils();
	// Hold Space on an empty box (or the mic) to talk - live sessions only.
	const canTalk = !onResume && !onSend;
	const voice = useHoldToTalk({
		paneId,
		onText: (text) => {
			setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text));
			inputRef.current?.focus();
		},
		onTap: () => setDraft((d) => `${d} `),
	});
	const setChat = useSessionView((s) => s.setChat);
	const sendNowKeys = useHotkeyDisplay("CHAT_SEND_NOW").text;
	// Type `/` and the agent's skills/commands are searchable, like the New
	// Session dialog. Picking one fills in `/name `; Enter then sends it.
	const { data: skills = [] } = electronTrpc.skills.list.useQuery();
	const [menuClosed, setMenuClosed] = useState(false);
	const [selected, setSelected] = useState(0);
	const token = bash ? undefined : skillToken(draft);
	const matches = useMemo(
		() => (token === undefined || menuClosed ? [] : matchSkills(skills, token)),
		[skills, token, menuClosed],
	);
	const activeIndex = Math.min(selected, Math.max(matches.length - 1, 0));
	const pickSkill = (name: string) => {
		setDraft((text) => insertSkill(text, name));
		setSelected(0);
	};
	useEffect(() => inputRef.current?.focus(), []);
	// Grow with the text, up to ~10 lines, like the desktop app's box.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on every draft change
	useEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
	}, [draft]);
	const send = async (now = false) => {
		const body = draft.trim();
		const sending = bash ? [] : attached;
		if (!body && sending.length === 0) return;
		// Not in bash mode: the note would run as part of the command.
		const text = bash ? `!${body}` : withDismissals(paneId, body);
		const paths = sending.map((item) => item.path);
		setDraft("");
		// Now, not via the effect: sending can remount this box (a resume, a
		// menu), and the new one would read the sent text back as a draft.
		useChatDrafts.getState().save(paneId, "");
		setBash(false);
		if (!bash) setAttached([]);
		// ponytail: blob URLs are never revoked - a few per session.
		onSent(
			text,
			sending.map((item) => item.preview),
		);
		if (onResume) {
			onResume([text, ...paths].filter(Boolean).join(" "));
			return;
		}
		if (onSend) {
			onSend([text, ...paths].filter(Boolean).join(" "));
			return;
		}
		try {
			// A bracketed paste, not typing: only a pasted path becomes an attachment.
			for (const path of paths)
				await write.mutateAsync({ paneId, data: `\x1b[200~${path}\x1b[201~ ` });
			// Claude reads a pasted image path off disk before it shows [Image #N],
			// and an Enter that lands meanwhile is dropped: nothing sends. ~150ms
			// was enough for a 6000x4000 JPEG; 500ms leaves room.
			// ponytail: fixed wait, poll the screen for [Image #N] if it ever misses.
			if (paths.length > 0)
				await new Promise((resolve) => setTimeout(resolve, 500));
			await typeIntoClaude(write.mutateAsync, paneId, text, now);
		} catch (error) {
			setDraft(body);
			setBash(bash);
			setAttached(sending);
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};
	return (
		<div className="px-4 pb-3 pt-1">
			<div
				className={cn(
					"relative rounded-[14px] border border-border bg-background px-3 pb-2 pt-2.5 focus-within:border-primary/60",
					bash && "border-pink-500/60 focus-within:border-pink-500",
					dragging && "border-primary bg-primary/10",
				)}
			>
				{matches.length > 0 && (
					<div className="absolute inset-x-0 bottom-full mb-1.5 overflow-hidden rounded-[10px] border border-border bg-popover shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
						<div className="max-h-[240px] overflow-y-auto py-1">
							{matches.map((skill, index) => (
								<button
									key={skill.name}
									type="button"
									onMouseEnter={() => setSelected(index)}
									// The textarea keeps focus: mousedown fires before blur.
									onMouseDown={(event) => {
										event.preventDefault();
										pickSkill(skill.name);
									}}
									className={cn(
										"flex w-full items-baseline gap-2 px-3 py-1 text-left",
										index === activeIndex && "bg-secondary",
									)}
								>
									<span className="shrink-0 font-mono text-[12.5px] font-semibold text-foreground">
										/{skill.name}
									</span>
									<span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
										{skill.description}
									</span>
								</button>
							))}
						</div>
					</div>
				)}
				{attached.length > 0 && (
					<PreviewStrip
						previews={attached.map((item) => item.preview)}
						onRemove={(index) =>
							setAttached((list) => list.filter((_, i) => i !== index))
						}
						className="mb-2"
					/>
				)}
				<div className="flex gap-1.5">
					{bash && (
						<span className="font-mono text-[13.5px] leading-relaxed text-pink-500">
							!
						</span>
					)}
					<textarea
						ref={inputRef}
						value={draft}
						rows={1}
						onChange={(event) => {
							const value = event.target.value;
							if (!bash && !draft && value.startsWith("!")) {
								setBash(true);
								setDraft(value.slice(1));
							} else setDraft(value);
							setMenuClosed(false);
						}}
						onPaste={(event) => {
							if (attach([...event.clipboardData.files]))
								event.preventDefault();
						}}
						onKeyDown={(event) => {
							if (
								event.key === " " &&
								(voice.holding() || (canTalk && !draft && !bash))
							) {
								event.preventDefault();
								if (!event.repeat) voice.press();
								return;
							}
							if (matches.length > 0 && !event.nativeEvent.isComposing) {
								// While the skill menu is open it owns these keys.
								if (event.key === "Escape") {
									event.preventDefault();
									setMenuClosed(true);
									return;
								}
								if (event.key === "ArrowDown" || event.key === "ArrowUp") {
									event.preventDefault();
									const step =
										event.key === "ArrowDown" ? 1 : matches.length - 1;
									setSelected((index) => (index + step) % matches.length);
									return;
								}
								if (
									(event.key === "Enter" && !event.shiftKey) ||
									event.key === "Tab"
								) {
									event.preventDefault();
									const match = matches[activeIndex];
									if (match) pickSkill(match.name);
									return;
								}
							}
							if (
								bash &&
								!draft &&
								(event.key === "Backspace" || event.key === "Escape")
							) {
								event.preventDefault();
								setBash(false);
								return;
							}
							if (
								event.key === "Enter" &&
								!event.shiftKey &&
								!event.nativeEvent.isComposing
							) {
								event.preventDefault();
								void send(isHotkey("CHAT_SEND_NOW", event.nativeEvent));
							}
						}}
						onKeyUp={(event) => {
							if (event.key === " ") voice.release();
						}}
						onBlur={voice.release}
						readOnly={voice.phase !== "idle"}
						placeholder={
							voice.phase === "listening"
								? voice.heard || "Listening... release Space to stop"
								: voice.phase === "processing"
									? voice.heard || "Transcribing..."
									: bash
										? "Run a shell command"
										: placeholder
						}
						className={cn(
							"block max-h-[220px] w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-faint-foreground",
							bash && "font-mono",
						)}
					/>
				</div>
				<div className="mt-1.5 flex items-center gap-2">
					{!noTerminal && (
						<button
							type="button"
							title="Show sessions as their terminal (Settings > Appearance)"
							onClick={() => setChat(false)}
							className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
						>
							<LuSquareTerminal className="size-3.5" />
							Terminal View
						</button>
					)}
					{bash ? (
						<span className="text-[11px] text-pink-500">
							Bash mode · Backspace on empty to exit
						</span>
					) : (
						<span className="text-[11px] text-faint-foreground">
							Enter to send · {sendNowKeys} to send now · Shift+Enter for a new
							line · ! for bash · / for skills
							{canTalk && " · hold Space to talk"}
						</span>
					)}
					{canTalk && (
						<button
							type="button"
							title="Hold to talk"
							aria-label="Hold to talk"
							onPointerDown={(event) => {
								event.preventDefault();
								voice.press(true);
							}}
							onPointerUp={voice.release}
							onPointerLeave={voice.release}
							className={cn(
								"ml-auto flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground",
								voice.phase !== "idle" && "bg-primary/15 text-primary",
							)}
						>
							<LuMic
								className={cn(
									"size-4",
									voice.phase === "listening" && "animate-pulse",
								)}
							/>
						</button>
					)}
					{working ? (
						<button
							type="button"
							title="Stop Claude"
							onClick={() =>
								onStop
									? onStop()
									: void interruptClaude(
											write.mutateAsync,
											utils.client.terminal.readScreen.query,
											paneId,
										)
							}
							className={cn(
								"flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background hover:opacity-85",
								!canTalk && "ml-auto",
							)}
						>
							<span className="size-[9px] rounded-[2px] bg-background" />
						</button>
					) : (
						<button
							type="button"
							title="Send (Enter)"
							disabled={!draft.trim() && attached.length === 0}
							onClick={() => void send()}
							className={cn(
								"flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-[14px] font-bold text-primary-foreground hover:brightness-110 disabled:opacity-40",
								!canTalk && "ml-auto",
							)}
						>
							↑
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
