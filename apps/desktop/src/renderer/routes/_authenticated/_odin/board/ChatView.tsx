import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { memo, useEffect, useRef, useState } from "react";
import { MarkdownRenderer } from "renderer/components/MarkdownRenderer";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { COMPACT_MARKDOWN } from "../components/TranscriptView";

type Item =
	| { kind: "user"; id: string; text: string }
	| { kind: "text"; id: string; text: string }
	| {
			kind: "tool";
			id: string;
			name: string;
			input: Record<string, unknown>;
			result?: string;
			isError?: boolean;
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
};

type Line = {
	type?: string;
	uuid?: string;
	isMeta?: boolean;
	isSidechain?: boolean;
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
		if (!line.message) return;
		const content = line.message.content;
		if (line.type === "user") {
			if (typeof content === "string") {
				const text = userText(content);
				if (text) next.push({ kind: "user", id, text });
				return;
			}
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
					const text = userText(block.text);
					if (text) next.push({ kind: "user", id: `${id}:${i}`, text });
				}
			}
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

/** Runs of tool calls fold into one group, like the desktop app hides its commands. */
export function segments(items: Item[]): (Item | Tool[])[] {
	const out: (Item | Tool[])[] = [];
	for (const item of items) {
		const last = out.at(-1);
		if (item.kind !== "tool") out.push(item);
		else if (Array.isArray(last)) last.push(item);
		else out.push([item]);
	}
	return out;
}

/** A question or plan approval Claude is still waiting on - a menu only the TUI draws. */
function asking(items: Item[]): boolean {
	const last = items.at(-1);
	return (
		last?.kind === "tool" &&
		last.result === undefined &&
		(last.name === "AskUserQuestion" || last.name === "ExitPlanMode")
	);
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
export function groupSummary(tools: Tool[]): string {
	const counts = new Map<string, number>();
	for (const tool of tools) {
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
	function ToolGroup({ tools }: { tools: Tool[] }) {
		const [open, setOpen] = useState(false);
		const running = tools.find((tool) => tool.result === undefined);
		const failed = tools.some((tool) => tool.isError);
		return (
			<div>
				<button
					type="button"
					onClick={() => setOpen((value) => !value)}
					className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] text-muted-foreground hover:bg-secondary"
				>
					<span className="shrink-0 text-[10px] text-faint-foreground">
						{open ? "▾" : "▸"}
					</span>
					<span className="shrink-0">{groupSummary(tools)}</span>
					{failed && <span className="shrink-0 text-danger">· error</span>}
					{running && (
						<span className="flex min-w-0 items-center gap-1.5 text-working">
							<span className="size-[6px] shrink-0 animate-pulse rounded-full bg-working" />
							<span className="truncate font-mono text-[11.5px]">
								{running.name} {toolSummary(running.input)}
							</span>
						</span>
					)}
				</button>
				{open && (
					<div className="ml-3 border-l border-border pl-2">
						{tools.map((tool) => (
							<ToolRow key={tool.id} item={tool} />
						))}
					</div>
				)}
			</div>
		);
	},
	// The array is rebuilt every render; its rows only change by reference.
	(prev, next) =>
		prev.tools.length === next.tools.length &&
		prev.tools.every((tool, i) => tool === next.tools[i]),
);

const ItemView = memo(function ItemView({ item }: { item: Item }) {
	if (item.kind === "tool") return <ToolRow item={item} />;
	if (item.kind === "user")
		return (
			<div className="ml-auto max-w-[85%] select-text cursor-text whitespace-pre-wrap break-words rounded-[14px] bg-secondary px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">
				{item.text}
			</div>
		);
	return (
		<div className="select-text cursor-text">
			<MarkdownRenderer
				content={item.text}
				style="default"
				allowHtml={false}
				className={COMPACT_MARKDOWN}
			/>
		</div>
	);
});

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
}) {
	const { data: home } = electronTrpc.window.getHomeDir.useQuery();
	// Claude files the conversation under the directory it STARTED in - the
	// transcript's first cwd. The pane's cwd has often moved on since (a feed
	// session starts in ~/dev and works in a worktree). Same query and options
	// as the card's pills, so it's a cache hit; the pane's cwd is the fallback.
	const { data: transcript } =
		electronTrpc.terminal.readClaudeTranscript.useQuery(
			{ sessionId: sessionId ?? "" },
			{ enabled: !!sessionId, retry: false, staleTime: 60_000 },
		);
	const startCwd = transcript?.cwd ?? cwd;
	const path =
		home && startCwd && sessionId
			? transcriptPath(home, startCwd, sessionId)
			: null;
	const { items, missing, poke } = useLiveItems(path, workspaceId);
	// What you just sent, shown at once - Claude writes it to the transcript a
	// beat later, and that echo replaces it.
	const [pending, setPending] = useState<{ id: number; text: string }[]>([]);
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
	const onSent = (text: string) => {
		const id = Date.now();
		pinnedRef.current = true;
		setPending((list) => [...list, { id, text }]);
		// Claude takes a moment to write it; look again a few times meanwhile.
		for (const ms of [150, 500, 1000]) setTimeout(poke, ms);
		// ponytail: an echo that never matches (Claude rewrote it) just expires.
		setTimeout(
			() => setPending((list) => list.filter((sent) => sent.id !== id)),
			30_000,
		);
	};
	const scrollRef = useRef<HTMLDivElement>(null);
	const pinnedRef = useRef(true);
	// Follow new output only while you're at the bottom - scrolling up to read
	// shouldn't get yanked back every second.
	// biome-ignore lint/correctness/useExhaustiveDependencies: items/pending are the trigger - new rows change scrollHeight
	useEffect(() => {
		const el = scrollRef.current;
		if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
	}, [items, pending]);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div
				ref={scrollRef}
				onScroll={(event) => {
					const el = event.currentTarget;
					pinnedRef.current =
						el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
				className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
			>
				<div className="flex flex-col gap-3">
					{missing && items.length === 0 && (
						<div className="select-text cursor-text text-[12px] text-muted-foreground">
							{missing}
						</div>
					)}
					{segments(items).map((segment) =>
						Array.isArray(segment) ? (
							<ToolGroup key={segment[0]?.id} tools={segment} />
						) : (
							<ItemView key={segment.id} item={segment} />
						),
					)}
					{pending.map((sent) => (
						<div
							key={sent.id}
							className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-[14px] bg-secondary px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground opacity-70"
						>
							{sent.text}
						</div>
					))}
					{working && (
						<div className="flex items-center gap-2 px-1.5 text-[12px] text-working">
							<span className="size-[10px] animate-spin rounded-full border-2 border-working border-t-transparent" />
							Working…
						</div>
					)}
				</div>
			</div>
			{onShowTerminal ? (
				<>
					{asking(items) && (
						<div className="px-5 pb-1 text-[12px] text-muted-foreground">
							Claude is asking you a question - its choices only show in the
							terminal:{" "}
							<button
								type="button"
								onClick={onShowTerminal}
								className="text-link hover:underline"
							>
								answer it there
							</button>
						</div>
					)}
					<Composer
						paneId={paneId}
						working={working}
						onSent={onSent}
						onStop={onStop}
					/>
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
 * Its own component so a keystroke re-renders the box, not the conversation.
 * Text goes in as a bracketed paste when it spans lines (a bare newline would
 * submit early), then Enter in its own write. An image paste is Ctrl+V into the
 * PTY: Claude Code reads the clipboard image itself and attaches it.
 */
function Composer({
	paneId,
	working,
	onSent,
	onStop,
}: {
	paneId: string;
	working: boolean;
	onSent: (text: string) => void;
	onStop?: () => void;
}) {
	const [draft, setDraft] = useState("");
	const [images, setImages] = useState(0);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const write = electronTrpc.terminal.write.useMutation();
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
		const text = draft.trim();
		if (!text && images === 0) return;
		setDraft("");
		setImages(0);
		if (text) onSent(text);
		try {
			if (text)
				await write.mutateAsync({
					paneId,
					data: text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text,
				});
			await new Promise((resolve) => setTimeout(resolve, 30));
			await write.mutateAsync({ paneId, data: "\r" });
		} catch (error) {
			setDraft(text);
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};
	return (
		<div className="px-4 pb-3 pt-1">
			<div className="rounded-[14px] border border-border bg-background px-3 pb-2 pt-2.5 focus-within:border-primary/60">
				<textarea
					ref={inputRef}
					value={draft}
					rows={1}
					onChange={(event) => setDraft(event.target.value)}
					onPaste={(event) => {
						const hasImage = [...event.clipboardData.items].some((item) =>
							item.type.startsWith("image/"),
						);
						if (!hasImage) return;
						event.preventDefault();
						write.mutate({ paneId, data: "\x16" });
						setImages((count) => count + 1);
					}}
					onKeyDown={(event) => {
						if (
							event.key === "Enter" &&
							!event.shiftKey &&
							!event.nativeEvent.isComposing
						) {
							event.preventDefault();
							void send();
						}
					}}
					placeholder="Reply to Claude"
					className="block max-h-[220px] w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-faint-foreground"
				/>
				<div className="mt-1.5 flex items-center gap-2">
					{images > 0 && (
						<span className="rounded-md bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
							🖼 {images} image{images > 1 ? "s" : ""} attached
						</span>
					)}
					<span className="text-[11px] text-faint-foreground">
						Enter to send · Shift+Enter for a new line
					</span>
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
							disabled={!draft.trim() && images === 0}
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
