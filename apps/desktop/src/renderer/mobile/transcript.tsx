import { useMemo, useState } from "react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import { type BriefUrgency, freshTldr, latestReply } from "shared/latest-reply";
import {
	bangCommandNotes,
	bangCommands,
	localCommand,
	splitActionItems,
} from "../routes/_authenticated/_odin/board/action-items";
import {
	collectRefs,
	linkify,
} from "../routes/_authenticated/_odin/board/chat-links";
import { launchRequest } from "../routes/_authenticated/_odin/board/launch-request";
import { ActionCard } from "./action-card";
import { Markdown } from "./markdown";

type Message = {
	role: "user" | "assistant";
	text: string;
	at?: string | null;
	/** Thumbnails of the images pasted with it. */
	images?: string[];
	/** A `!` command and what it printed. */
	shell?: { command?: string; stdout: string; stderr: string };
};

/** Images in a bubble: thumbnails, and one tapped opens over the screen. */
export function Thumbnails({ images }: { images?: string[] }) {
	const [open, setOpen] = useState<string | null>(null);
	if (!images?.length) return null;
	return (
		<div className="mb-1.5 flex flex-wrap gap-1.5">
			{images.map((src, i) => (
				<button
					// biome-ignore lint/suspicious/noArrayIndexKey: the same image can be pasted twice
					key={i}
					type="button"
					aria-label="Open the image"
					onClick={() => setOpen(src)}
				>
					<img
						src={src}
						alt=""
						className="max-h-40 max-w-[200px] rounded-xl object-cover"
					/>
				</button>
			))}
			{open && (
				<button
					type="button"
					aria-label="Close the image"
					onClick={() => setOpen(null)}
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
				>
					<img
						src={open}
						alt=""
						className="max-h-full max-w-full object-contain"
					/>
				</button>
			)}
		</div>
	);
}

/** When a message was sent, as the board's chat shows it: "Oct 19, 23:29". */
export function messageTime(at?: string | null): string | null {
	if (!at) return null;
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function Time({
	at,
	className = "",
}: {
	at?: string | null;
	className?: string;
}) {
	const label = messageTime(at);
	if (!label || !at) return null;
	return (
		<time dateTime={at} className={`block text-[11px] ${className}`}>
			{label}
		</time>
	);
}

/**
 * What your bubble shows: of a launch prompt (task + standing rules + reply
 * format), just the request you typed, as on the board; the whole prompt
 * once you ask for Odin's part.
 */
export function userBubbleText(
	text: string,
	{ full, images }: { full: boolean; images: boolean },
): { shown: string; folds: boolean } {
	const request = launchRequest(text);
	const raw = request === null || full ? text : request;
	const shown = images ? raw.replace(/\[Image #\d+\]\s*/g, "").trim() : raw;
	return { shown, folds: request !== null };
}

/** Your message, whole: a launch prompt folds to your request. */
function UserBubble({ message }: { message: Message }) {
	const [full, setFull] = useState(false);
	const { shown, folds } = userBubbleText(message.text, {
		full,
		images: !!message.images,
	});
	return (
		<div className="my-2 ml-10 select-text break-words rounded-2xl rounded-br-md bg-(--brand) px-3 py-2 text-[15px] leading-snug text-primary-foreground">
			<Thumbnails images={message.images} />
			<div className="whitespace-pre-wrap">{shown}</div>
			{folds && (
				<button
					type="button"
					onClick={() => setFull(!full)}
					className="mt-1 py-1 text-[13px] font-medium text-primary-foreground/80 underline underline-offset-2"
				>
					{full ? "Hide Odin's prompt" : "Show Odin's prompt"}
				</button>
			)}
			<Time at={message.at} className="mt-1 text-right opacity-70" />
		</div>
	);
}

/** Lines a shell card shows before Show all, as on the board. */
const SHELL_LINES = 12;

/** A `!` command and its output: a terminal card, never a bubble of yours. */
function ShellCard({ shell }: { shell: NonNullable<Message["shell"]> }) {
	const [all, setAll] = useState(false);
	const output = [shell.stdout, shell.stderr].filter(Boolean).join("\n");
	const lines = output.split("\n");
	const shown = all ? output : lines.slice(-SHELL_LINES).join("\n");
	return (
		<div className="my-2 overflow-hidden rounded-[10px] border border-border bg-secondary/60 font-mono text-[12px] leading-snug">
			{shell.command !== undefined && (
				<div className="select-text break-all border-b border-border px-2.5 py-1.5 text-foreground">
					$ {shell.command}
				</div>
			)}
			{output ? (
				<pre
					className={`select-text overflow-x-auto whitespace-pre-wrap break-words px-2.5 py-1.5 ${shell.stderr && !shell.stdout ? "text-danger" : "text-soft-foreground"}`}
				>
					{shown}
				</pre>
			) : (
				<div className="px-2.5 py-1.5 text-faint-foreground">No output</div>
			)}
			{lines.length > SHELL_LINES && (
				<button
					type="button"
					onClick={() => setAll(!all)}
					className="px-2.5 pb-1.5 font-sans text-[13px] font-medium text-primary"
				>
					{all ? "Show less" : `Show all ${lines.length} lines`}
				</button>
			)}
		</div>
	);
}

/**
 * The reply's `!` blocks, each with Run: in Claude's session, or `!local`
 * in the session's Shell on your Mac. Claude's line above a block says
 * what it does.
 */
function RunCard({
	text,
	run,
}: {
	text: string;
	run: (command: string) => Promise<unknown>;
}) {
	const [state, setState] = useState<
		Record<string, "running" | "sent" | string>
	>({});
	const notes = bangCommandNotes(text);
	return (
		<div className="my-2 mr-6 flex flex-col gap-2.5 rounded-2xl border border-border bg-card px-3 py-2.5">
			<div className="text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
				Commands to run
			</div>
			{bangCommands(text).map((command) => {
				const local = localCommand(command);
				const status = state[command];
				return (
					<div key={command} className="flex flex-col gap-1">
						{notes[command] && (
							<div className="text-[13px] text-muted-foreground">
								{notes[command]}
							</div>
						)}
						<code className="select-text break-all rounded-md bg-secondary px-2 py-1 font-mono text-[12px]">
							{local ?? command}
						</code>
						<div className="flex items-center gap-2">
							<button
								type="button"
								disabled={status === "running" || status === "sent"}
								onClick={() => {
									setState((all) => ({ ...all, [command]: "running" }));
									run(command).then(
										() => setState((all) => ({ ...all, [command]: "sent" })),
										(error: Error) =>
											setState((all) => ({ ...all, [command]: error.message })),
									);
								}}
								className="h-8 rounded-lg border border-attention/40 px-3 text-sm font-medium text-attention disabled:opacity-50"
							>
								{status === "sent"
									? "Ran"
									: status === "running"
										? "Running…"
										: local
											? "Run on my Mac"
											: "Run"}
							</button>
							{status && status !== "running" && status !== "sent" && (
								<span className="select-text text-[12px] text-danger">
									{status}
								</span>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
}

type Segment =
	| { kind: "message"; message: Message; index: number }
	| {
			kind: "fold";
			at: number;
			messages: { message: Message; index: number }[];
	  };

/**
 * A turn's in-between messages fold away: of each run of Odin's messages
 * between two of yours, only the last stays open - the answer - and the
 * steps before it sit behind one toggle.
 */
export function segments(messages: Message[]): Segment[] {
	const out: Segment[] = [];
	let run: { message: Message; index: number }[] = [];
	const flush = () => {
		if (run.length > 1)
			out.push({ kind: "fold", at: run[0].index, messages: run.slice(0, -1) });
		const last = run.at(-1);
		if (last) out.push({ kind: "message", ...last });
		run = [];
	};
	messages.forEach((message, index) => {
		if (message.role === "assistant") run.push({ message, index });
		else {
			flush();
			out.push({ kind: "message", message, index });
		}
	});
	flush();
	return out;
}

export type ReplyBrief =
	| {
			last?: string | null;
			urgency?: BriefUrgency | null;
			replyAt?: string | null;
	  }
	| null
	| undefined;

/** The latest reply's TL;DR, right above its action items. */
function TldrCard({ tldr }: { tldr: string }) {
	return (
		<div className="my-2 mr-6 rounded-2xl border border-border bg-secondary/60 px-3 py-2 text-[15px] leading-snug">
			<div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
				TL;DR
			</div>
			<div className="select-text text-foreground">
				<Markdown text={tldr} />
			</div>
		</div>
	);
}

/**
 * The latest reply's TL;DR: only for one too long to read at a glance. A
 * short reply is its own summary, and a TL;DR under it said the same twice.
 */
export function leadingTldr<T extends { long: boolean }>(
	tldr: T | null,
): T | null {
	return tldr?.long ? tldr : null;
}

/** The conversation: your messages, Odin's answers, folds, and the action items. */
export function Transcript({
	messages,
	brief,
	send,
	run,
	dismissed,
	onDismiss,
}: {
	messages: Message[];
	/** The brief's TL;DR of the latest reply, and which reply it describes. */
	brief: ReplyBrief;
	send: (text: string) => void;
	/** Runs one of the latest reply's `!` commands; none from an older Odin. */
	run?: (command: string) => Promise<unknown>;
	/** Action items you dismissed in this session. */
	dismissed?: string[];
	onDismiss?: (item: string) => void;
}) {
	// "#676" and "CRR-851" this session has a URL for link to it, as on the board.
	const refs = useMemo(
		() => collectRefs(messages.map((message) => message.text)),
		[messages],
	);
	const [open, setOpen] = useState<Set<number>>(() => new Set());
	const replyAt = messages.findLastIndex((m) => m.role === "assistant");
	// Never a TL;DR of an older reply on a newer one: freshTldr checks which.
	const tldr = freshTldr(latestReply(messages), brief);
	// Only the latest reply's items are still asked; older ones were answered.
	const actionsAt = messages.findLastIndex(
		(message) =>
			message.role === "assistant" && !!splitActionItems(message.text).actions,
	);
	// The Mac runs only the commands of the latest reply that has any.
	const commandsAt = messages.findLastIndex(
		(message) =>
			message.role === "assistant" && bangCommands(message.text).length > 0,
	);
	const bubble = ({ message, index }: { message: Message; index: number }) => {
		if (message.shell) return <ShellCard key={index} shell={message.shell} />;
		if (message.role === "user")
			return <UserBubble key={index} message={message} />;
		const { body, actions } = splitActionItems(message.text);
		const latest = index === replyAt ? leadingTldr(tldr) : null;
		return (
			<div key={index}>
				{body && (
					<div className="mt-3 -mb-1 ml-1 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
						Odin
					</div>
				)}
				{body && (
					<div className="my-2 mr-6 rounded-2xl rounded-bl-md border border-border bg-card px-3 py-2 text-[15px] leading-snug text-soft-foreground">
						<Markdown text={linkify(body, refs)} />
					</div>
				)}
				{body && (
					<Time at={message.at} className="-mt-1 ml-1 text-faint-foreground" />
				)}
				{/* The summary sits right above what it asks of you, as on the board. */}
				{latest && <TldrCard tldr={latest.last} />}
				{index === commandsAt && run && (
					<RunCard text={message.text} run={run} />
				)}
				{index === actionsAt && actions && (
					<ActionCard
						actions={linkify(actions, refs)}
						body={body}
						send={send}
						dismissed={dismissed}
						onDismiss={onDismiss}
					/>
				)}
			</div>
		);
	};
	return (
		<>
			{segments(messages).map((segment) => {
				if (segment.kind === "message") return bubble(segment);
				const shown = open.has(segment.at);
				const count = segment.messages.length;
				const Chevron = shown ? LuChevronDown : LuChevronRight;
				return (
					<div key={`fold-${segment.at}`}>
						<button
							type="button"
							onClick={() =>
								setOpen((all) => {
									const next = new Set(all);
									if (shown) next.delete(segment.at);
									else next.add(segment.at);
									return next;
								})
							}
							className="my-1 flex items-center gap-1 py-1 text-[13px] text-muted-foreground"
						>
							<Chevron className="size-4" />
							{shown ? "Hide" : "Show"} {count} earlier message
							{count === 1 ? "" : "s"}
						</button>
						{shown && (
							<div className="border-l-2 border-border pl-2 opacity-80">
								{segment.messages.map(bubble)}
							</div>
						)}
					</div>
				);
			})}
		</>
	);
}
