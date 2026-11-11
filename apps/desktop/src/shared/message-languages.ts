/**
 * The language a message is written in, told apart by its script. Latin script
 * counts as English: it can't tell English from French, and the drafts it is
 * for are mostly English.
 */
const SCRIPTS: [string, RegExp][] = [
	["Hebrew", /[֐-׿]/],
	["Arabic", /[؀-ۿ]/],
	["Russian", /[Ѐ-ӿ]/],
	["Greek", /[Ͱ-Ͽ]/],
	["Hindi", /[ऀ-ॿ]/],
	["Thai", /[฀-๿]/],
	["Korean", /[가-힯]/],
	["Japanese", /[぀-ヿ]/],
	["Chinese", /[一-鿿]/],
];

export function messageLanguage(text: string): string {
	return SCRIPTS.find(([, script]) => script.test(text))?.[0] ?? "English";
}

/**
 * The languages I write my messages in, most used first: English always, plus
 * any other one in at least 5% of them (and 2 messages), so a stray word in
 * another script doesn't count.
 */
export function messageLanguages(messages: string[]): string[] {
	const counts = new Map<string, number>([["English", 0]]);
	for (const message of messages) {
		const language = messageLanguage(message);
		counts.set(language, (counts.get(language) ?? 0) + 1);
	}
	return [...counts]
		.filter(
			([language, n]) =>
				language === "English" || (n >= 2 && n >= messages.length * 0.05),
		)
		.sort((a, b) => b[1] - a[1])
		.map(([language]) => language);
}
