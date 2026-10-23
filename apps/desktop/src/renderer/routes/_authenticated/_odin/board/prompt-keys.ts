/**
 * The keys that answer the menus Claude Code draws for AskUserQuestion and
 * ExitPlanMode. Pure, so the board's chat and the iPhone app answer them the
 * same way.
 */

export type Question = {
	question?: string;
	header?: string;
	multiSelect?: boolean;
	options?: { label?: string; description?: string; preview?: string }[];
};

const DOWN = "\x1b[B";

/**
 * Single-choice options with a preview draw beside it, and there a number only
 * moves the cursor: Enter picks. That layout has no "Type something" row, and
 * "Chat about this" has no number - the arrows reach it.
 */
export function hasPreview(question: Question): boolean {
	return !question.multiSelect && !!question.options?.some((o) => o.preview);
}

/** A typed answer goes into a one-line field. */
export function oneLine(text: string | undefined): string {
	return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The keys Claude Code's question menu takes, as measured on 2.1.294. Each
 * question lists its options, then "Type something", then "Chat about this".
 * A single-choice question answers on an option's number, or on the number of
 * "Type something", the typed text and Enter. A multi-select one toggles each
 * pick by number (the cursor stays on the first row), arrows down to "Type
 * something" for typed text, then Tab and Enter move on. Enter submits on the
 * review tab the last answer lands on, except for a lone single-choice
 * question, which its answer submits. A question with previews takes its
 * number and Enter.
 */
export function answerKeys(
	questions: Question[],
	picks: number[][],
	others: string[] = [],
): string[] {
	const keys = questions.flatMap((question, i) => {
		const count = question.options?.length ?? 0;
		const other = oneLine(others[i]);
		if (hasPreview(question)) return [String((picks[i]?.[0] ?? 0) + 1), "\r"];
		if (!question.multiSelect)
			return other
				? [String(count + 1), other, "\r"]
				: [String((picks[i]?.[0] ?? 0) + 1)];
		const toggles = (picks[i] ?? []).map((pick) => String(pick + 1));
		return other
			? [...toggles, ...Array(count).fill(DOWN), other, "\t", "\r"]
			: [...toggles, "\t"];
	});
	const lone = questions.length === 1 && !questions[0]?.multiSelect;
	return lone ? keys : [...keys, "\r"];
}

/** The menu lists "Type something" after the options, then "Chat about this". */
export function chatAboutKeys(questions: Question[]): string[] {
	const count = questions[0]?.options?.length ?? 0;
	return questions[0] && hasPreview(questions[0])
		? [...Array(count).fill(DOWN), "\r"]
		: [String(count + 2)];
}
