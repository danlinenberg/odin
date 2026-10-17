import { useState } from "react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import { splitActionItems } from "../routes/_authenticated/_odin/board/action-items";
import { ActionCard } from "./action-card";
import { Markdown } from "./markdown";

type Message = { role: "user" | "assistant"; text: string };

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

/** The conversation: your messages, Odin's answers, folds, and the action items. */
export function Transcript({
	messages,
	send,
}: {
	messages: Message[];
	send: (text: string) => void;
}) {
	const [open, setOpen] = useState<Set<number>>(() => new Set());
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
					className="my-2 ml-10 select-text whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-3 py-2 text-[15px] leading-snug"
				>
					{message.text}
				</div>
			);
		const { body, actions } = splitActionItems(message.text);
		return (
			<div key={index}>
				{body && (
					<div className="my-2 mr-6 rounded-2xl rounded-bl-md border border-border bg-card px-3 py-2 text-[15px] leading-snug text-soft-foreground">
						<Markdown text={body} />
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
