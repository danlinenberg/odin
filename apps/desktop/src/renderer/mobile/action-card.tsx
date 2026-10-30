import { useState } from "react";
import { LuCheck, LuX } from "react-icons/lu";
import { isDismissed } from "shared/dismissed-match";
import {
	actionItemList,
	isAnswerItem,
	isApprovalItem,
	isDoneItem,
	isYouOnly,
	itemDetail,
	itemOptions,
} from "../routes/_authenticated/_odin/board/action-items";
import { Markdown } from "./markdown";
import { RunCommand } from "./run-command";

/**
 * The latest reply's ACTION ITEMS as the board's chat shows them: one row per
 * item with its button - Do it, Approve, Done - or, for a question, its
 * [A | B] choices and a box for your own answer. A tap sends the same words
 * the desktop sends.
 */
export function ActionCard({
	actions,
	body,
	send,
	dismissed = [],
	onDismiss,
	commands,
}: {
	actions: string;
	/** The reply's `!` commands, each under the item it belongs to (placeCommands). */
	commands?: {
		under: string[][];
		foot: string[];
		notes: Record<string, string>;
		run: (command: string) => Promise<unknown>;
	};
	/** The reply above the items: a tap on an item shows its paragraph. */
	body: string;
	send: (text: string) => void;
	/** Items you closed, here or on the board: hidden, as the board hides them. */
	dismissed?: string[];
	/** The X; none from an older Odin. */
	onDismiss?: (item: string) => void;
}) {
	// Numbered as Claude listed them, so "item 3" still means its third.
	const items = actionItemList(actions)
		.map((item, index) => ({ item, number: index + 1 }))
		.filter(({ item }) => !isDismissed(dismissed, item));
	if (items.length === 0) return null;
	return (
		<div className="my-2 rounded-xl border border-attention/35 bg-attention/[0.07] px-3 py-2.5">
			<div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-attention">
				Action items
			</div>
			<ol className="space-y-2.5">
				{items.map(({ item, number }) => (
					<ActionRow
						key={number}
						item={item}
						number={number}
						detail={itemDetail(item, body, number)}
						send={send}
						onDismiss={onDismiss && (() => onDismiss(item))}
						commands={
							commands && {
								list: commands.under[number - 1] ?? [],
								notes: commands.notes,
								run: commands.run,
							}
						}
					/>
				))}
			</ol>
			{commands && commands.foot.length > 0 && (
				<div className="mt-2.5 flex flex-col gap-2">
					{commands.foot.map((command) => (
						<RunCommand
							key={command}
							command={command}
							note={commands.notes[command]}
							run={commands.run}
						/>
					))}
				</div>
			)}
		</div>
	);
}

/** A choice can be a whole sentence: the button grows to its lines instead of running off the screen. */
const BUTTON =
	"min-h-8 max-w-full break-words rounded-lg border border-attention/40 px-3 py-1 text-left text-sm font-medium text-attention disabled:opacity-50";

function ActionRow({
	item,
	number,
	detail,
	send,
	onDismiss,
	commands,
}: {
	item: string;
	number: number;
	/** This item's `!` commands, run from under it as on the board. */
	commands?: {
		list: string[];
		notes: Record<string, string>;
		run: (command: string) => Promise<unknown>;
	};
	/** The reply's paragraph about this item, shown on a tap. */
	detail: string | null;
	send: (text: string) => void;
	onDismiss?: () => void;
}) {
	const [sent, setSent] = useState(false);
	const [why, setWhy] = useState(false);
	const [typed, setTyped] = useState("");
	const { text, options } = itemOptions(item);
	const approve = isApprovalItem(item);
	// As on the board: an approval gets its Approve button, even with choices.
	const asks = !approve && (isAnswerItem(item) || options.length > 0);
	const done = !approve && isDoneItem(item);
	const go = (message: string) => {
		send(message);
		setSent(true);
	};
	const answer = (reply: string) =>
		go(`Action item ${number} (${text}): ${reply}`);
	return (
		<li className="text-[15px] leading-snug text-soft-foreground">
			<div className="flex gap-2">
				<span className="shrink-0 font-semibold text-attention">{number}.</span>
				<div className="min-w-0 flex-1">
					<Markdown text={text} />
				</div>
				{onDismiss && (
					<button
						type="button"
						aria-label="Dismiss this item"
						onClick={onDismiss}
						className="-mr-1 flex size-8 shrink-0 items-center justify-center text-muted-foreground"
					>
						<LuX className="size-4" />
					</button>
				)}
			</div>
			{/* The paragraph of the reply this item comes from: the board's hover. */}
			{detail && (
				<button
					type="button"
					onClick={() => setWhy(!why)}
					className="mt-0.5 ml-5 py-0.5 text-[13px] font-medium text-muted-foreground"
				>
					{why ? "Hide why" : "Why?"}
				</button>
			)}
			{why && detail && (
				<div className="mt-1 ml-5 border-l-2 border-attention/30 pl-2.5 text-[14px] text-muted-foreground">
					<Markdown text={detail} />
				</div>
			)}
			{commands && commands.list.length > 0 && (
				<div className="mt-1.5 flex flex-col gap-2 pl-5">
					{commands.list.map((command) => (
						<RunCommand
							key={command}
							command={command}
							note={commands.notes[command]}
							run={commands.run}
						/>
					))}
				</div>
			)}
			<div className="mt-1.5 flex flex-wrap gap-1.5 pl-5">
				{sent ? (
					<span className="flex items-center gap-1 text-sm text-muted-foreground">
						<LuCheck className="size-4" />
						Sent
					</span>
				) : asks ? (
					<>
						{options.map((option) => (
							<button
								key={option}
								type="button"
								onClick={() => answer(option)}
								className={BUTTON}
							>
								{option}
							</button>
						))}
						<form
							className="flex w-full gap-1.5"
							onSubmit={(event) => {
								event.preventDefault();
								if (typed.trim()) answer(typed.trim());
							}}
						>
							<input
								value={typed}
								onChange={(event) => setTyped(event.target.value)}
								placeholder={
									options.length ? "Or type your own" : "Your answer"
								}
								className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-secondary px-2.5 text-base outline-none"
							/>
							{typed.trim() && (
								<button type="submit" className={BUTTON}>
									Send
								</button>
							)}
						</form>
					</>
				) : isYouOnly(item) ? null : (
					<button
						type="button"
						onClick={() =>
							approve
								? go(`Approved - go ahead with action item ${number}: ${text}`)
								: done
									? answer("Done")
									: go(`Do action item ${number} for me: ${text}`)
						}
						className={BUTTON}
					>
						{approve ? "Approve" : done ? "Done" : "Do it"}
					</button>
				)}
			</div>
		</li>
	);
}
