import { odinIcon } from "@odin/ui/icons/preset-icons";
import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuChevronRight, LuSquareTerminal, LuTerminal } from "react-icons/lu";
import { MarkdownRenderer } from "renderer/components/MarkdownRenderer";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useCompacting } from "renderer/stores/compacting";
import { openUrl } from "renderer/stores/in-app-browser";
import { useSessionView } from "renderer/stores/session-view";
import {
	insertSkill,
	matchSkills,
	skillToken,
} from "../components/skill-picker";
import { COMPACT_MARKDOWN } from "../components/TranscriptView";
import { PlanCard, QuestionCard, ScreenMenuCard } from "./ChatPrompts";
import { collectRefs, linkify } from "./chat-links";
import { parseScreenMenu } from "./screen-menu";

type Item =
	| { kind: "user"; id: string; text: string; images?: string[] }
	| { kind: "text"; id: string; text: string }
	| {
			kind: "tool";
			id: string;
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
	message?: { content?: string | Block[] };
	/** A message you sent mid-turn rides in as a queued_command attachment. */
	attachment?: { type?: string; prompt?: string | Block[] };
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
	lines.forEach((line, lineIndex) => {
		if (line.isMeta || line.isSidechain) return;
		const id = line.uuid ?? `${items.length}-${lineIndex}`;
		if (line.attachment?.type === "queued_command") {
			const text = userText(blockText(line.attachment.prompt));
			if (text) next.push({ kind: "user", id, text });
			return;
		}
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
		if (line.type === "user") {
			if (typeof content === "string") {
				const text = userText(content);
				if (text) next.push({ kind: "user", id, text });
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
					const at = toolIndex.get(block.tool_use_id);
					const tool = at === undefined ? undefined : next[at];
					if (at !== undefined && tool?.kind === "tool")
						next[at] = {
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
						...(imagesShown ? {} : { images }),
					});
					imagesShown = true;
				}
			}
			if (!imagesShown) next.push({ kind: "user", id, text: "", images });
		} else if (line.type === "assistant" && Array.isArray(content)) {
			for (const [i, block] of content.entries()) {
				if (block.type === "text" && block.text?.trim())
					next.push({ kind: "text", id: `${id}:${i}`, text: block.text });
				else if (block.type === "tool_use" && block.id) {
					toolIndex.set(block.id, next.length);
					next.push({
						kind: "tool",
						id: block.id,
						name: block.name ?? "Tool",
						input: block.input ?? {},
					});
				}
			}
		}
	});
	return next;
}

/**
 * The transcript, tailed: one read of the last TAIL_BYTES, then only the bytes
 * appended since. The old full read re-parsed the whole file every poll.
 */
function useLiveItems(path: string | null, workspaceId: string) {
	const [items, setItems] = useState<Item[]>([]);
	const [missing, setMissing] = useState<string | null>(null);
	const utils = electronTrpc.useUtils();
	// Read now instead of at the next poll - after a send, so Claude's echo of
	// your message lands as soon as it's written.
	const pokeRef = useRef(() => {});
	useEffect(() => {
		if (!path) return;
		let cancelled = false;
		let offset: number | null = null;
		let skipFirstLine = false;
		let remainder = "";
		const decoder = new TextDecoder();
		let timer: ReturnType<typeof setTimeout>;
		let running = false;
		let again = false;
		setItems([]);
		setMissing(null);
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
					const bytes =
						read.kind === "bytes"
							? Uint8Array.from(atob(read.content as string), (c) =>
									c.charCodeAt(0),
								)
							: new TextEncoder().encode(read.content);
					const chunk = remainder + decoder.decode(bytes, { stream: true });
					const parts = chunk.split("\n");
					remainder = parts.pop() ?? "";
					if (skipFirstLine) {
						parts.shift();
						skipFirstLine = false;
					}
					const lines = parts.flatMap((part) => {
						try {
							return [JSON.parse(part) as Line];
						} catch {
							return [];
						}
					});
					if (lines.length) setItems((prev) => applyLines(prev, lines));
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
		pokeRef.current = () => void tick();
		void tick();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [path, workspaceId, utils]);
	return { items, missing, poke: () => pokeRef.current() };
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
				<span className="shrink-0 font-semibold text-foreground">
					{item.name}
				</span>
				<span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground">
					{toolSummary(item.input)}
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
							{item.result.slice(0, 20_000)}
						</pre>
					)}
				</div>
			)}
		</div>
	);
});

type Tool = Extract<Item, { kind: "tool" }>;
type Group = (Tool | Extract<Item, { kind: "text" }>)[];

/**
 * Runs of tool calls fold into one group, like the desktop app hides its
 * commands. A line of narration between two runs folds in too, so a long
 * stretch of work is one section, not a ladder of "Ran 1 command".
 */
export function segments(items: Item[]): (Item | Group)[] {
	const out: (Item | Group)[] = [];
	for (const item of items) {
		const last = out.at(-1);
		const before = out.at(-2);
		if (item.kind !== "tool") out.push(item);
		else if (Array.isArray(last)) last.push(item);
		else if (last?.kind === "text" && Array.isArray(before)) {
			out.pop();
			before.push(last, item);
		} else out.push([item]);
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

const VERBS: Record<string, [string, string]> = {
	Bash: ["ran", "command"],
	Read: ["read", "file"],
	Edit: ["edited", "file"],
	MultiEdit: ["edited", "file"],
	Write: ["wrote", "file"],
	Grep: ["searched", "time"],
	Glob: ["searched", "time"],
};

/** "Ran 3 commands, read 2 files" - same verb counted once. */
export function groupSummary(group: Group): string {
	const counts = new Map<string, number>();
	for (const tool of group) {
		if (tool.kind !== "tool") continue;
		const [verb, noun] = VERBS[tool.name] ?? ["used", "tool"];
		const key = `${verb} ${noun}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const text = [...counts]
		.map(([key, n]) => {
			const [verb, noun] = key.split(" ");
			return `${verb} ${n} ${noun}${n > 1 ? "s" : ""}`;
		})
		.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

const ToolGroup = memo(
	function ToolGroup({ group }: { group: Group }) {
		const [open, setOpen] = useState(false);
		const tools = group.filter((item): item is Tool => item.kind === "tool");
		const running = tools.find((tool) => tool.result === undefined);
		const failed = tools.some((tool) => tool.isError);
		return (
			<div className="flex min-w-0 flex-col">
				<button
					type="button"
					onClick={() => setOpen((value) => !value)}
					className="flex min-w-0 max-w-full items-center gap-2 self-start rounded-lg border border-border bg-secondary px-2.5 py-1 text-left text-[12px] text-soft-foreground hover:bg-accent hover:text-foreground"
				>
					<LuTerminal className="size-3.5 shrink-0" />
					<span className="shrink-0">{groupSummary(group)}</span>
					{/* ponytail: muted - a failed command is routine, Claude retries */}
					{failed && (
						<span className="shrink-0 text-faint-foreground">· error</span>
					)}
					{running && (
						<span className="flex min-w-0 items-center gap-1.5 text-working">
							<span className="size-[6px] shrink-0 animate-pulse rounded-full bg-working" />
							<span className="truncate font-mono text-[11.5px]">
								{running.name} {toolSummary(running.input)}
							</span>
						</span>
					)}
					<LuChevronRight
						className={cn(
							"size-3.5 shrink-0 transition-transform",
							open && "rotate-90",
						)}
					/>
				</button>
				{open && (
					<div className="mt-1.5 rounded-lg border border-border bg-secondary/20 p-1.5">
						{group.map((item) =>
							item.kind === "tool" ? (
								<ToolRow key={item.id} item={item} />
							) : (
								// ponytail: plain text, not markdown - it's a one-line aside
								<div
									key={item.id}
									className="select-text whitespace-pre-wrap px-2 py-1 text-[12px] text-muted-foreground"
								>
									{item.text}
								</div>
							),
						)}
					</div>
				)}
			</div>
		);
	},
	// The array is rebuilt every render; its rows only change by reference.
	(prev, next) =>
		prev.group.length === next.group.length &&
		prev.group.every((item, i) => item === next.group[i]),
);

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

/** Seconds since a moment, ticking. */
function Elapsed({ since }: { since: number }) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	return (
		<span className="tabular-nums text-muted-foreground">
			{Math.max(0, Math.round((now - since) / 1000))}s
		</span>
	);
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
}: {
	text: string;
	images?: Preview[];
	pending?: boolean;
}) {
	// A launch prompt (task + standing rules + reply format) fills the screen;
	// show just the request you typed until clicked open.
	const request = launchRequest(text);
	const long =
		request !== null || text.length > 300 || text.split("\n").length > 4;
	const [open, setOpen] = useState(false);
	return (
		<div
			className={cn(
				"mt-5 mb-1 ml-auto max-w-[75%] select-text cursor-text break-words rounded-2xl rounded-br-md border border-primary/30 bg-primary/15 px-4 py-2.5 text-[13.5px] leading-relaxed text-foreground shadow-sm first:mt-0",
				pending && "opacity-60",
				pending && ENTER,
			)}
		>
			{images && images.length > 0 && (
				<PreviewStrip previews={images} className={text ? "mb-2" : ""} />
			)}
			<div className={cn(long && !open && "line-clamp-3")}>
				{/* Typed line breaks stay: markdown would fold them into spaces. */}
				<MarkdownRenderer
					content={open || request === null ? text : request}
					style="default"
					allowHtml={false}
					className={cn(
						COMPACT_MARKDOWN,
						"text-[13.5px] text-foreground [&_li]:whitespace-pre-wrap [&_p]:whitespace-pre-wrap",
					)}
				/>
			</div>
			{long && (
				<button
					type="button"
					onClick={() => setOpen(!open)}
					className="mt-1 text-[12px] text-link hover:underline"
				>
					{open
						? "Show less"
						: request === null
							? "Show more"
							: "Show full prompt"}
				</button>
			)}
		</div>
	);
}

/** A pasted image or video: an image's URL alone, or a video with its file. */
type Preview = string | { url: string; video: true };

function PreviewStrip({
	previews,
	className,
}: {
	previews: Preview[];
	className?: string;
}) {
	// A click toggles one picture between thumbnail and a larger view.
	const [enlarged, setEnlarged] = useState<string | null>(null);
	return (
		<div className={cn("flex flex-wrap gap-2", className)}>
			{previews.map((preview) =>
				typeof preview === "string" ? (
					<button
						key={preview}
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
						key={preview.url}
						src={preview.url}
						controls
						muted
						className="max-h-40 max-w-60 rounded-lg border border-border"
					/>
				),
			)}
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

/** The numbered or bulleted lines of an ACTION ITEMS block; [] for "none". */
export function actionItemList(text: string): string[] {
	return [...text.matchAll(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/gm)].map(
		(match) => match[1]?.trim() ?? "",
	);
}

/**
 * An item that asks you to tell Claude something - a choice, a value, a
 * preference. It gets a reply box instead of a bare "Do it".
 */
export function isAnswerItem(item: string): boolean {
	return /^\W*(tell|answer|decide|choose|pick|confirm|let me know|say)\b/i.test(
		item,
	);
}

/**
 * The choices Claude offered as a trailing "[A | B | C]", and the item without
 * them. The launch prompt asks for that shape; no brackets means no choices.
 */
export function itemOptions(item: string): { text: string; options: string[] } {
	const match = item.match(/\s*\[([^\]]*\|[^\]]*)\](?!\()\W*$/);
	if (match?.index === undefined) return { text: item, options: [] };
	return {
		text: item.slice(0, match.index),
		options: (match[1] ?? "")
			.split("|")
			.map((option) => option.trim())
			.filter(Boolean),
	};
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
	number,
	onDo,
	buttonColumn,
}: {
	item: string;
	number: number;
	onDo: DoItem;
	/** Some item in the list has a button - line this one's number up with it. */
	buttonColumn: boolean;
}) {
	const [sent, setSent] = useState(false);
	const [answer, setAnswer] = useState("");
	const { text, options } = itemOptions(item);
	const approve = isApprovalItem(item);
	const asks = !approve && (isAnswerItem(item) || options.length > 0);
	const send = (reply?: string) => {
		setSent(true);
		onDo(text, number, approve, reply);
	};
	return (
		<li className="flex items-start gap-2">
			{/* The button leads the row - you scan for it first. */}
			{isYouOnly(item) ? (
				buttonColumn && <span className="w-[64px] shrink-0" />
			) : (
				<button
					type="button"
					title={
						approve
							? "Tell Claude you approve and to go ahead"
							: asks
								? "Send your answer to Claude"
								: "Ask Claude to do this for you"
					}
					disabled={sent || (asks && !answer.trim())}
					onClick={() => send(asks ? answer.trim() : undefined)}
					className={cn(ACTION_BUTTON, "w-[64px]")}
				>
					{sent ? "Sent" : approve ? "Approve" : "Do it"}
				</button>
			)}
			<span className="w-4 shrink-0 pt-px text-right text-[13px] tabular-nums text-muted-foreground">
				{number}.
			</span>
			<div className="min-w-0 flex-1">
				<MarkdownRenderer
					content={text}
					style="default"
					allowHtml={false}
					className={COMPACT_MARKDOWN}
				/>
				{asks && !sent && (
					<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
						{options.map((option) => (
							<button
								key={option}
								type="button"
								title="Send this choice to Claude"
								onClick={() => send(option)}
								className={ACTION_BUTTON}
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
							className="min-w-[160px] flex-1 rounded-md border border-attention/30 bg-transparent px-2 py-0.5 text-[12px] outline-none placeholder:text-muted-foreground/70 focus:border-attention/60"
						/>
					</div>
				)}
			</div>
		</li>
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
function ActionItems({ text, onDo }: { text: string; onDo?: DoItem }) {
	// text arrives linkified from ItemView.
	const items = onDo ? actionItemList(text) : [];
	const buttonColumn = !items.every(isYouOnly);
	return (
		<div className="mt-2 rounded-xl border border-attention/35 bg-attention/[0.07] px-4 py-3">
			<div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.08em] text-attention">
				Action items
			</div>
			{onDo && items.length > 0 ? (
				<ol className="flex flex-col gap-1">
					{items.map((item, index) => (
						<ActionItemRow
							// biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed once written
							key={index}
							item={item}
							number={index + 1}
							onDo={onDo}
							buttonColumn={buttonColumn}
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
		</div>
	);
}

const ItemView = memo(
	function ItemView({
		item,
		refs,
		onDo,
	}: {
		item: Item;
		refs: Map<string, string>;
		/** Changes only when a new ref appears - the memo's cue to re-link. */
		refsKey: string;
		onDo?: DoItem;
	}) {
		if (item.kind === "tool") return <ToolRow item={item} />;
		if (item.kind === "compact") return <CompactRow item={item} />;
		if (item.kind === "user")
			return <UserBubble text={item.text} images={item.images} />;
		const { body, actions } = splitActionItems(linkify(item.text, refs));
		return (
			<div className="select-text cursor-text">
				{body && (
					<MarkdownRenderer
						content={body}
						style="default"
						allowHtml={false}
						className={COMPACT_MARKDOWN}
					/>
				)}
				{actions && <ActionItems text={actions} onDo={onDo} />}
			</div>
		);
	},
	(prev, next) =>
		prev.item === next.item &&
		prev.refsKey === next.refsKey &&
		prev.onDo === next.onDo,
);

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
}: {
	paneId: string;
	sessionId: string | null;
	cwd: string | undefined;
	workspaceId: string;
	working?: boolean;
	/** Omitted for an ended session: nothing to type into, so no composer. */
	onShowTerminal?: () => void;
	/** Interrupt the turn - the drawer's Interrupt, so the card leaves Working too. */
	onStop?: () => void;
	/** Ended session: resume it with this as the opening message. */
	onResumeWith?: (text: string) => void;
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
	const { items, missing, poke } = useLiveItems(path, workspaceId);
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
	// What you just sent, shown at once - Claude writes it to the transcript a
	// beat later, and that echo replaces it.
	const [pending, setPending] = useState<
		{ id: number; text: string; previews?: Preview[] }[]
	>([]);
	useEffect(() => {
		setPending((list) =>
			list.filter(
				(sent) =>
					!items.some(
						(item) => item.kind === "user" && item.text.includes(sent.text),
					),
			),
		);
	}, [items]);
	const onSent = (text: string, previews?: Preview[]) => {
		const id = Date.now();
		pinnedRef.current = true;
		setPending((list) => [...list, { id, text, previews }]);
		// Claude takes a moment to write it; look again a few times meanwhile.
		for (const ms of [150, 500, 1000]) setTimeout(poke, ms);
		// ponytail: an echo that never matches (Claude rewrote it) just expires.
		setTimeout(
			() => setPending((list) => list.filter((sent) => sent.id !== id)),
			30_000,
		);
	};
	const onSentRef = useRef(onSent);
	onSentRef.current = onSent;
	// Stable, so the memoized rows don't all re-render on every poll.
	// A ref, so a fresh arrow from the drawer doesn't re-render every message.
	const onResumeRef = useRef(onResumeWith);
	onResumeRef.current = onResumeWith;
	const doItem = useCallback(
		(item: string, number: number, approve: boolean, answer?: string) => {
			const text = approve
				? `Approved - go ahead with action item ${number}: ${item}`
				: answer !== undefined
					? `Action item ${number} (${item}): ${answer}`
					: `Do action item ${number} for me: ${item}`;
			if (onResumeRef.current) {
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
	const scrollRef = useRef<HTMLDivElement>(null);
	const pinnedRef = useRef(true);
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
		(!missing || missing.startsWith("Not on disk yet"));
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div
				ref={scrollRef}
				onScroll={(event) => {
					const el = event.currentTarget;
					pinnedRef.current =
						el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
				// Links open in Odin's browser, like everywhere else on the board.
				onClickCapture={(event) => {
					const anchor = (event.target as HTMLElement).closest("a");
					if (anchor?.href.startsWith("http")) {
						event.preventDefault();
						openUrl(anchor.href);
					}
				}}
				className="min-h-0 flex-1 overflow-y-auto px-8 py-6"
			>
				<div className="flex flex-col gap-2.5">
					{starting ? (
						<div className="flex items-center gap-3 text-[12.5px] text-working">
							<OdinMark className="animate-[odin-nod_1.6s_ease-in-out_infinite]" />
							Starting session…
							{/* Before its first turn the CLI can stop on a terminal-only
							    prompt (folder trust, bypass-permissions warning) that no
							    transcript ever shows. */}
							<button
								type="button"
								onClick={onShowTerminal}
								className="text-[11.5px] text-muted-foreground hover:text-foreground"
							>
								Stuck? Show terminal
							</button>
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
								/>
							);
						const key = Array.isArray(segment) ? segment[0]?.id : segment.id;
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
									) : (
										<ItemView
											item={segment}
											refs={refs}
											refsKey={refsKey}
											onDo={onShowTerminal || onResumeWith ? doItem : undefined}
										/>
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
								<button
									type="button"
									onClick={onShowTerminal}
									className="mt-1.5 text-[11.5px] text-muted-foreground hover:text-foreground"
								>
									Answer in Terminal View instead
								</button>
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
								<button
									type="button"
									onClick={onShowTerminal}
									className="mt-1.5 text-[11.5px] text-muted-foreground hover:text-foreground"
								>
									Answer in Terminal View instead
								</button>
							</div>
						</div>
					)}
					{working && !prompt && !screenMenu && !starting && (
						<div className="flex items-center gap-3 text-[12.5px] text-working">
							{/* Odin's icon, nodding along while Claude works. */}
							<OdinMark className="animate-[odin-nod_1.6s_ease-in-out_infinite]" />
							{compacting === null ? (
								"Working…"
							) : (
								<>
									Compacting conversation…
									<Elapsed since={compacting} />
								</>
							)}
						</div>
					)}
				</div>
			</div>
			{onShowTerminal ? (
				<>
					{/* While a menu waits, typed text would land in it - the card answers. */}
					{!prompt && !screenMenu && (
						<Composer
							paneId={paneId}
							working={working}
							onSent={onSent}
							onStop={onStop}
						/>
					)}
				</>
			) : (
				<div className="border-t border-border px-5 py-2 text-center text-[11.5px] text-muted-foreground">
					Session ended - Resume to reply
				</div>
			)}
		</div>
	);
}

/**
 * Types a message into Claude's PTY and submits it. Text goes in as a
 * bracketed paste when it spans lines (a bare newline would submit early),
 * then Enter in its own write.
 */
async function typeIntoClaude(
	write: (input: { paneId: string; data: string }) => Promise<unknown>,
	paneId: string,
	text: string,
) {
	if (text)
		await write({
			paneId,
			data: text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text,
		});
	await new Promise((resolve) => setTimeout(resolve, 30));
	await write({ paneId, data: "\r" });
}

/**
 * Its own component so a keystroke re-renders the box, not the conversation.
 * An image paste is Ctrl+V into the
 * PTY: Claude Code reads the clipboard image itself and attaches it. Claude
 * takes no video, so a pasted video file goes in as its path.
 */
function Composer({
	paneId,
	working,
	onSent,
	onStop,
}: {
	paneId: string;
	working: boolean;
	onSent: (text: string, previews?: Preview[]) => void;
	onStop?: () => void;
}) {
	const [draft, setDraft] = useState("");
	// "!" on an empty box switches to bash mode, like the terminal's prompt.
	const [bash, setBash] = useState(false);
	const [previews, setPreviews] = useState<Preview[]>([]);
	const [dragging, setDragging] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const write = electronTrpc.terminal.write.useMutation();
	const setChat = useSessionView((s) => s.setChat);
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
	const send = async () => {
		const body = draft.trim();
		if (bash ? !body : !body && previews.length === 0) return;
		const text = bash ? `!${body}` : body;
		setDraft("");
		setBash(false);
		setPreviews([]);
		// ponytail: blob URLs are never revoked - a few per session.
		onSent(text, previews);
		try {
			await typeIntoClaude(write.mutateAsync, paneId, text);
		} catch (error) {
			setDraft(body);
			setBash(bash);
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};
	return (
		<div className="px-4 pb-3 pt-1">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone - dragging media onto the box attaches it, the textarea stays the input */}
			<div
				className={cn(
					"relative rounded-[14px] border border-border bg-background px-3 pb-2 pt-2.5 focus-within:border-primary/60",
					bash && "border-pink-500/60 focus-within:border-pink-500",
					dragging && "border-primary bg-primary/10",
				)}
				onDragOver={(event) => {
					if (!event.dataTransfer.types.includes("Files")) return;
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={(event) => {
					if (!event.dataTransfer.types.includes("Files")) return;
					// Stop Electron from opening a dropped file in the window.
					event.preventDefault();
					setDragging(false);
					const files = [...event.dataTransfer.files];
					const images = files.filter((f) => f.type.startsWith("image/"));
					const videos = files.filter((f) => f.type.startsWith("video/"));
					if (images.length === 0 && videos.length === 0) return;
					// Dropped files have no clipboard entry, so their paths go in the draft.
					const paths = [...images, ...videos]
						.map((file) => window.webUtils.getPathForFile(file))
						.filter(Boolean);
					setDraft((text) => [text, ...paths].filter(Boolean).join(" "));
					setPreviews((list) => [
						...list,
						...images.map((file) => URL.createObjectURL(file)),
						...videos.map((file) => ({
							url: URL.createObjectURL(file),
							video: true as const,
						})),
					]);
				}}
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
				{previews.length > 0 && (
					<PreviewStrip previews={previews} className="mb-2" />
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
							const files = [...event.clipboardData.files];
							const images = files.filter((f) => f.type.startsWith("image/"));
							const videos = files.filter((f) => f.type.startsWith("video/"));
							if (images.length === 0 && videos.length === 0) return;
							event.preventDefault();
							if (images.length > 0) write.mutate({ paneId, data: "\x16" });
							const paths = videos
								.map((file) => window.webUtils.getPathForFile(file))
								.filter(Boolean);
							if (paths.length > 0)
								setDraft((text) => [text, ...paths].filter(Boolean).join(" "));
							setPreviews((list) => [
								...list,
								...images.map((file) => URL.createObjectURL(file)),
								...videos.map((file) => ({
									url: URL.createObjectURL(file),
									video: true as const,
								})),
							]);
						}}
						onKeyDown={(event) => {
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
								void send();
							}
						}}
						placeholder={bash ? "Run a shell command" : "Reply to Claude"}
						className={cn(
							"block max-h-[220px] w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-faint-foreground",
							bash && "font-mono",
						)}
					/>
				</div>
				<div className="mt-1.5 flex items-center gap-2">
					<button
						type="button"
						title="Show sessions as their terminal (Settings > Appearance)"
						onClick={() => setChat(false)}
						className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
					>
						<LuSquareTerminal className="size-3.5" />
						Terminal View
					</button>
					{bash ? (
						<span className="text-[11px] text-pink-500">
							Bash mode · Backspace on empty to exit
						</span>
					) : (
						<span className="text-[11px] text-faint-foreground">
							Enter to send · Shift+Enter for a new line · ! for bash · / for
							skills
						</span>
					)}
					{working ? (
						<button
							type="button"
							title="Stop Claude"
							onClick={() =>
								onStop ? onStop() : write.mutate({ paneId, data: "\x03" })
							}
							className="ml-auto flex size-7 items-center justify-center rounded-full bg-foreground text-background hover:opacity-85"
						>
							<span className="size-[9px] rounded-[2px] bg-background" />
						</button>
					) : (
						<button
							type="button"
							title="Send (Enter)"
							disabled={!draft.trim() && previews.length === 0}
							onClick={() => void send()}
							className="ml-auto flex size-7 items-center justify-center rounded-full bg-primary text-[14px] font-bold text-primary-foreground hover:brightness-110 disabled:opacity-40"
						>
							↑
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
