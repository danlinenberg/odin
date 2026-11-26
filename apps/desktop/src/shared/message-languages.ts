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

/**
 * The language a draft is written in, by which script has the most letters in
 * its prose: code blocks, inline code, URLs and mentions are left out, so a
 * Hebrew draft full of "cron" and "xvfb-run" stays Hebrew, and one Hebrew word
 * in an English draft doesn't flip it.
 */
export function draftLanguage(text: string): string {
	const prose = text
		.replace(/(```|~~~)[\s\S]*?(\1|$)/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/https?:\/\/\S+|<[@#!][^>]*>/g, " ");
	let best = "English";
	let most = prose.match(/[A-Za-z]/g)?.length ?? 0;
	for (const [language, script] of SCRIPTS) {
		const n = prose.match(new RegExp(script.source, "g"))?.length ?? 0;
		if (n > most) [best, most] = [language, n];
	}
	return best;
}
