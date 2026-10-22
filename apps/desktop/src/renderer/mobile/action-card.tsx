import { useState } from "react";
import { LuCheck } from "react-icons/lu";
import {
	actionItemList,
	isAnswerItem,
	isApprovalItem,
	isDoneItem,
	isYouOnly,
	itemOptions,
} from "../routes/_authenticated/_odin/board/action-items";
import { Markdown } from "./markdown";

/**
 * The latest reply's ACTION ITEMS as the board's chat shows them: one row per
 * item with its button - Do it, Approve, Done - or, for a question, its
 * [A | B] choices and a box for your own answer. A tap sends the same words
 * the desktop sends.
 */
export function ActionCard({
	actions,
	send,
}: {
	actions: string;
	send: (text: string) => void;
}) {
	const items = actionItemList(actions);
	if (items.length === 0) return null;
	return (
		<div className="my-2 rounded-xl border border-attention/35 bg-attention/[0.07] px-3 py-2.5">
			<div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-attention">
				Action items
			</div>
			<ol className="space-y-2.5">
				{items.map((item, index) => (
					<ActionRow
						// biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed for its reply
						key={index}
						item={item}
						number={index + 1}
						send={send}
					/>
				))}
			</ol>
		</div>
	);
}

/** A choice can be a whole sentence: the button grows to its lines instead of running off the screen. */
const BUTTON =
	"min-h-8 max-w-full break-words rounded-lg border border-attention/40 px-3 py-1 text-left text-sm font-medium text-attention disabled:opacity-50";

function ActionRow({
	item,
	number,
	send,
}: {
	item: string;
	number: number;
	send: (text: string) => void;
}) {
	const [sent, setSent] = useState(false);
	const [typed, setTyped] = useState("");
	const { text, options } = itemOptions(item);
	const approve = isApprovalItem(item);
	const asks = isAnswerItem(item) || options.length > 0;
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
			</div>
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
