import { cn } from "@odin/ui/utils";
import { useState } from "react";
import { MarkdownRenderer } from "renderer/components/MarkdownRenderer";
import { BUTTON } from "../components/pill";
import { COMPACT_MARKDOWN } from "../components/TranscriptView";
import { menuKeys, type ScreenMenu } from "./screen-menu";

type Question = {
	question?: string;
	header?: string;
	multiSelect?: boolean;
	options?: { label?: string; description?: string }[];
};

/**
 * The keys Claude Code's question menu takes, as measured on 2.1.292: a lone
 * single-choice question answers on its number. Otherwise each question takes
 * its number (multi-select: each pick's number toggles it, Tab moves on), and
 * Enter submits on the review tab the last answer lands on.
 */
export function answerKeys(questions: Question[], picks: number[][]): string[] {
	if (questions.length === 1 && !questions[0]?.multiSelect)
		return [String((picks[0]?.[0] ?? 0) + 1)];
	const keys = questions.flatMap((question, i) =>
		question.multiSelect
			? [...(picks[i] ?? []).map((pick) => String(pick + 1)), "\t"]
			: [String((picks[i]?.[0] ?? 0) + 1)],
	);
	return [...keys, "\r"];
}

/** The menu lists "Type something" after the options, then "Chat about this". */
export function chatAboutKeys(questions: Question[]): string[] {
	return [String((questions[0]?.options?.length ?? 0) + 2)];
}

/** AskUserQuestion, answered in the chat - its menu only draws in the TUI. */
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
	const [sent, setSent] = useState(false);
	const ready = questions.every((_, i) => (picks[i]?.length ?? 0) > 0);
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
		// One single-choice question: the click is the answer, like the menu.
		if (questions.length === 1 && !question?.multiSelect) {
			setSent(true);
			onKeys(answerKeys(questions, next));
		}
	};
	const single = questions.length === 1 && !questions[0]?.multiSelect;
	return (
		<div className="rounded-xl border border-attention/35 bg-attention/[0.07] px-4 py-3">
			<div className="mb-2 text-[11px] font-semibold uppercase tracking-[.08em] text-attention">
				Claude is asking
			</div>
			<div className="space-y-4">
				{questions.map((question, qi) => (
					<div key={`${qi}-${question.question}`}>
						<div className="mb-2 text-[13.5px] text-foreground">
							{question.question}
							{question.multiSelect && (
								<span className="ml-2 text-[11px] text-muted-foreground">
									pick any
								</span>
							)}
						</div>
						<div className="flex flex-wrap gap-2">
							{(question.options ?? []).map((option, oi) => {
								const chosen = picks[qi]?.includes(oi);
								return (
									<button
										key={`${oi}-${option.label}`}
										type="button"
										disabled={sent}
										title={option.description}
										onClick={() => pick(qi, oi)}
										className={cn(
											"max-w-full rounded-lg border px-3 py-1.5 text-left text-[12.5px] disabled:opacity-60",
											chosen
												? "border-primary bg-primary/20 text-foreground"
												: "border-border bg-secondary text-soft-foreground hover:bg-accent hover:text-foreground",
										)}
									>
										<span className="font-medium">{option.label}</span>
										{option.description &&
											option.description !== option.label && (
												<span className="block text-[11.5px] text-muted-foreground">
													{option.description}
												</span>
											)}
									</button>
								);
							})}
						</div>
					</div>
				))}
			</div>
			{single && (
				<button
					type="button"
					disabled={sent}
					onClick={() => {
						setSent(true);
						onKeys(chatAboutKeys(questions));
					}}
					className="mt-3 text-[11.5px] text-muted-foreground hover:text-foreground disabled:opacity-60"
				>
					Chat about this
				</button>
			)}
			{!single && (
				<button
					type="button"
					disabled={!ready || sent}
					onClick={() => {
						setSent(true);
						onKeys(answerKeys(questions, picks));
					}}
					className={cn(
						"mt-3 rounded-[7px] px-3 py-1.5 text-xs font-semibold disabled:opacity-50",
						BUTTON.primary,
					)}
				>
					{sent ? "Sending…" : "Submit answers"}
				</button>
			)}
		</div>
	);
}

/**
 * ExitPlanMode, decided in the chat. Option 1 approves (whatever mode it
 * names); option 3 is the "tell Claude what to change" field.
 */
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
		<div className="rounded-xl border border-attention/35 bg-attention/[0.07] px-4 py-3">
			<div className="mb-2 text-[11px] font-semibold uppercase tracking-[.08em] text-attention">
				Claude's plan - ready to start?
			</div>
			{plan && (
				<div className="mb-3 max-h-[360px] overflow-y-auto rounded-lg border border-border bg-background/60 px-3 py-2">
					<MarkdownRenderer
						content={plan}
						style="default"
						allowHtml={false}
						className={COMPACT_MARKDOWN}
					/>
				</div>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					disabled={sent}
					onClick={() => {
						setSent(true);
						onKeys(["1"]);
					}}
					className={cn(
						"rounded-[7px] px-3 py-1.5 text-xs font-semibold disabled:opacity-50",
						BUTTON.primary,
					)}
				>
					Approve
				</button>
				<input
					value={feedback}
					disabled={sent}
					onChange={(event) => setFeedback(event.target.value)}
					placeholder="Or tell Claude what to change"
					className="min-w-[240px] flex-1 rounded-[7px] border border-border bg-background px-2.5 py-1.5 text-[12.5px] text-foreground outline-none focus:border-primary/60"
				/>
				<button
					type="button"
					disabled={sent || !feedback.trim()}
					onClick={() => {
						setSent(true);
						onKeys(["3", feedback.trim(), "\r"]);
					}}
					className={cn(
						"rounded-[7px] px-3 py-1.5 text-xs font-semibold disabled:opacity-50",
						BUTTON.secondary,
					)}
				>
					Ask for changes
				</button>
			</div>
		</div>
	);
}

/**
 * Any other pick-one menu the TUI draws (a startup warning, folder trust, a
 * slash-command picker), mirrored from the screen - it never reaches the
 * transcript.
 */
export function ScreenMenuCard({
	menu,
	onKeys,
}: {
	menu: ScreenMenu;
	onKeys: (keys: string[]) => void;
}) {
	const [sent, setSent] = useState(false);
	return (
		<div className="rounded-xl border border-attention/35 bg-attention/[0.07] px-4 py-3">
			<div className="mb-2 text-[11px] font-semibold uppercase tracking-[.08em] text-attention">
				The terminal is asking
			</div>
			{menu.title && (
				<div className="mb-3 max-h-[240px] select-text cursor-text overflow-y-auto whitespace-pre-wrap text-[12.5px] text-soft-foreground">
					{menu.title}
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				{menu.options.map((option, index) => (
					<button
						key={`${index}-${option}`}
						type="button"
						disabled={sent}
						onClick={() => {
							setSent(true);
							onKeys(menuKeys(menu, index));
						}}
						className={cn(
							"max-w-full rounded-lg border px-3 py-1.5 text-left text-[12.5px] font-medium disabled:opacity-60",
							index === menu.selected
								? "border-primary/60 bg-primary/10 text-foreground"
								: "border-border bg-secondary text-soft-foreground hover:bg-accent hover:text-foreground",
						)}
					>
						{option}
					</button>
				))}
			</div>
		</div>
	);
}
