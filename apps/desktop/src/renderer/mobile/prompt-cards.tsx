import { useState } from "react";
import {
	answerKeys,
	chatAboutKeys,
	hasPreview,
	oneLine,
	type Question,
} from "../routes/_authenticated/_odin/board/prompt-keys";
import {
	menuKeys,
	type ScreenMenu,
} from "../routes/_authenticated/_odin/board/screen-menu";
import { Markdown } from "./markdown";

/**
 * The board's question, plan and menu cards (ChatPrompts), for a thumb:
 * Claude's menus answered with buttons, not by reading the terminal and
 * pressing numbers.
 */

const CARD =
	"my-2 mr-6 rounded-2xl border border-attention/35 bg-attention/10 px-3 py-2.5";
const LABEL =
	"mb-2 text-[11px] font-semibold uppercase tracking-wide text-attention";
const PRIMARY =
	"h-9 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground disabled:opacity-50";
const SECONDARY =
	"h-9 rounded-lg border border-border bg-secondary px-3.5 text-sm font-semibold disabled:opacity-50";
const INPUT =
	"h-10 w-full min-w-0 rounded-lg border bg-secondary px-2.5 text-base outline-none disabled:opacity-60";

const option = (chosen: boolean) =>
	`w-full rounded-lg border px-3 py-2 text-left text-[15px] leading-snug disabled:opacity-60 ${chosen ? "border-primary bg-primary/20" : "border-border bg-secondary"}`;

/** AskUserQuestion: tap an option, or type your own. */
export function QuestionCard({
	input,
	onKeys,
}: {
	input: Record<string, unknown>;
	onKeys: (keys: string[]) => void;
}) {
	const questions = (
		Array.isArray(input.questions) ? input.questions : []
	) as Question[];
	const [picks, setPicks] = useState<number[][]>(() => questions.map(() => []));
	const [others, setOthers] = useState<string[]>(() => questions.map(() => ""));
	const [sent, setSent] = useState(false);
	const single = questions.length === 1 && !questions[0]?.multiSelect;
	const ready = questions.every(
		(_, i) => (picks[i]?.length ?? 0) > 0 || !!oneLine(others[i]),
	);
	const send = (keys: string[]) => {
		setSent(true);
		onKeys(keys);
	};
	const pick = (qi: number, oi: number) => {
		const question = questions[qi];
		const next = picks.map((list, i) =>
			i !== qi
				? list
				: question?.multiSelect
					? list.includes(oi)
						? list.filter((x) => x !== oi)
						: [...list, oi]
					: [oi],
		);
		setPicks(next);
		if (!question?.multiSelect)
			setOthers(others.map((text, i) => (i === qi ? "" : text)));
		// One single-choice question: the tap is the answer, as on the board.
		if (single) send(answerKeys(questions, next));
	};
	const type = (qi: number, text: string) => {
		setOthers(others.map((old, i) => (i === qi ? text : old)));
		if (!questions[qi]?.multiSelect && text)
			setPicks(picks.map((list, i) => (i === qi ? [] : list)));
	};
	return (
		<div className={CARD}>
			<div className={LABEL}>Claude is asking</div>
			<div className="flex flex-col gap-4">
				{questions.map((question, qi) => (
					<div key={`${qi}-${question.question}`}>
						<div className="mb-2 select-text text-[15px] text-foreground">
							{question.question}
							{question.multiSelect && (
								<span className="ml-2 text-[12px] text-muted-foreground">
									pick any
								</span>
							)}
						</div>
						<div className="flex flex-col gap-1.5">
							{(question.options ?? []).map((choice, oi) => (
								<button
									key={`${oi}-${choice.label}`}
									type="button"
									disabled={sent}
									onClick={() => pick(qi, oi)}
									className={option(!!picks[qi]?.includes(oi))}
								>
									<span className="font-medium">{choice.label}</span>
									{choice.description &&
										choice.description !== choice.label && (
											<span className="mt-0.5 block text-[13px] text-muted-foreground">
												{choice.description}
											</span>
										)}
								</button>
							))}
						</div>
						{!hasPreview(question) && (
							<input
								value={others[qi] ?? ""}
								disabled={sent}
								aria-label={`Other answer to: ${question.question ?? "the question"}`}
								onChange={(event) => type(qi, event.target.value)}
								placeholder={
									question.multiSelect
										? "Something else? Type it here"
										: "Or type your own answer"
								}
								className={`mt-2 ${INPUT} ${oneLine(others[qi]) ? "border-primary" : "border-input"}`}
							/>
						)}
					</div>
				))}
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-3">
				{(!single || oneLine(others[0])) && (
					<button
						type="button"
						disabled={!ready || sent}
						onClick={() => send(answerKeys(questions, picks, others))}
						className={PRIMARY}
					>
						{sent ? "Sent" : single ? "Send answer" : "Submit answers"}
					</button>
				)}
				{single && (
					<button
						type="button"
						disabled={sent}
						onClick={() => send(chatAboutKeys(questions))}
						className="py-2 text-[13px] text-muted-foreground disabled:opacity-60"
					>
						Chat about this
					</button>
				)}
			</div>
		</div>
	);
}

/** ExitPlanMode: read the plan, then Approve or say what to change. */
export function PlanCard({
	input,
	onKeys,
}: {
	input: Record<string, unknown>;
	onKeys: (keys: string[]) => void;
}) {
	const [feedback, setFeedback] = useState("");
	const [sent, setSent] = useState(false);
	const plan = typeof input.plan === "string" ? input.plan : "";
	return (
		<div className={CARD}>
			<div className={LABEL}>Claude's plan - ready to start?</div>
			{plan && (
				<div className="mb-3 max-h-[50dvh] overflow-y-auto rounded-lg border border-border bg-card px-3 py-2 text-[15px] leading-snug text-soft-foreground">
					<Markdown text={plan} />
				</div>
			)}
			<div className="flex flex-col gap-2">
				<button
					type="button"
					disabled={sent}
					onClick={() => {
						setSent(true);
						onKeys(["1"]);
					}}
					className={`${PRIMARY} self-start`}
				>
					{sent ? "Sent" : "Approve"}
				</button>
				<div className="flex gap-2">
					<input
						value={feedback}
						disabled={sent}
						onChange={(event) => setFeedback(event.target.value)}
						placeholder="Or tell Claude what to change"
						className={`${INPUT} flex-1 border-input`}
					/>
					<button
						type="button"
						disabled={sent || !oneLine(feedback)}
						onClick={() => {
							setSent(true);
							onKeys(["3", oneLine(feedback), "\r"]);
						}}
						className={`${SECONDARY} shrink-0`}
					>
						Ask for changes
					</button>
				</div>
			</div>
		</div>
	);
}

/** Any other pick-one menu the terminal draws, read off its screen. */
export function MenuCard({
	menu,
	onKeys,
}: {
	menu: ScreenMenu;
	onKeys: (keys: string[]) => void;
}) {
	const [sent, setSent] = useState(false);
	return (
		<div className={CARD}>
			<div className={LABEL}>The terminal is asking</div>
			{menu.title && (
				<div className="mb-2.5 max-h-[30dvh] select-text overflow-y-auto whitespace-pre-wrap text-[14px] text-soft-foreground">
					{menu.title}
				</div>
			)}
			<div className="flex flex-col gap-1.5">
				{menu.options.map((choice, index) => (
					<button
						key={`${index}-${choice}`}
						type="button"
						disabled={sent}
						onClick={() => {
							setSent(true);
							onKeys(menuKeys(menu, index));
						}}
						className={option(index === menu.selected)}
					>
						{choice}
					</button>
				))}
			</div>
		</div>
	);
}
