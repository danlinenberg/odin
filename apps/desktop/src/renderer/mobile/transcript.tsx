import { useState } from "react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import { type BriefUrgency, freshTldr, latestReply } from "shared/latest-reply";
import { splitActionItems } from "../routes/_authenticated/_odin/board/action-items";
import { ActionCard } from "./action-card";
import { Markdown } from "./markdown";

type Message = {
	role: "user" | "assistant";
	text: string;
	at?: string | null;
	/** Thumbnails of the images pasted with it. */
	images?: string[];
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

/**
 * The latest reply's TL;DR, marked Needs you or FYI as the brief judged it:
 * the top strip of that reply's own card, so it reads as its summary.
 */
function TldrStrip({
	tldr,
	urgency,
}: {
	tldr: string;
	urgency: BriefUrgency | null;
}) {
	const needsYou = urgency === "needs-you";
	return (
		<div
			className={`px-3 py-2 ${needsYou ? "bg-attention/[0.07]" : "bg-secondary/60"}`}
		>
			<div
				className={`mb-0.5 text-[11px] font-semibold uppercase tracking-wide ${needsYou ? "text-attention" : "text-faint-foreground"}`}
			>
				TL;DR{urgency ? ` · ${needsYou ? "Needs you" : "FYI"}` : ""}
			</div>
			<div className="select-text text-foreground">
				<Markdown text={tldr} />
			</div>
		</div>
	);
}

/** The conversation: your messages, Odin's answers, folds, and the action items. */
export function Transcript({
	messages,
	brief,
	send,
}: {
	messages: Message[];
	/** The brief's TL;DR of the latest reply, and which reply it describes. */
	brief: ReplyBrief;
	send: (text: string) => void;
}) {
	const [open, setOpen] = useState<Set<number>>(() => new Set());
	const [fullReply, setFullReply] = useState(false);
	const replyAt = messages.findLastIndex((m) => m.role === "assistant");
	// Never a TL;DR of an older reply on a newer one: freshTldr checks which.
	const tldr = freshTldr(latestReply(messages), brief);
	// Only the latest reply's items are still asked; older ones were answered.
	const actionsAt = messages.findLastIndex(
		(message) =>
			message.role === "assistant" && !!splitActionItems(message.text).actions,
	);
	const bubble = ({ message, index }: { message: Message; index: number }) => {
		if (message.role === "user")
			return (
				<div
					key={index}
					className="my-2 ml-10 select-text whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3 py-2 text-[15px] leading-snug text-primary-foreground"
				>
					<Thumbnails images={message.images} />
					{message.images
						? message.text.replace(/\[Image #\d+\]\s*/g, "").trim()
						: message.text}
				</div>
			);
		const { body, actions } = splitActionItems(message.text);
		const latest = index === replyAt && tldr;
		// The board's chat: a long latest reply folds under its TL;DR.
		const folded = latest && tldr.long && !fullReply;
		const needsYou = latest && tldr.urgency === "needs-you";
		return (
			<div key={index}>
				{(body || latest) && (
					<div className="mt-3 -mb-1 ml-1 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
						Odin
					</div>
				)}
				{(body || latest) && (
					<div
						className={`my-2 mr-6 overflow-hidden rounded-2xl rounded-bl-md border bg-card text-[15px] leading-snug text-soft-foreground ${needsYou ? "border-attention/35" : "border-border"}`}
					>
						{latest && <TldrStrip tldr={tldr.last} urgency={tldr.urgency} />}
						{body && (
							<div
								className={`px-3 py-2 ${latest ? "border-t border-border" : ""}`}
							>
								{latest && (
									<div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
										Full reply
									</div>
								)}
								<div
									className={
										folded
											? "max-h-[6.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]"
											: undefined
									}
								>
									<Markdown text={body} />
								</div>
								{latest && tldr.long && (
									<button
										type="button"
										onClick={() => setFullReply((shown) => !shown)}
										className="mt-1 flex items-center gap-1 text-[13px] font-medium text-primary"
									>
										{fullReply ? (
											<LuChevronDown className="size-4" />
										) : (
											<LuChevronRight className="size-4" />
										)}
										{fullReply ? "Show less" : "Show full reply"}
									</button>
								)}
							</div>
						)}
					</div>
				)}
				{index === actionsAt && actions && (
					<ActionCard actions={actions} send={send} />
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
