import shortcodes from "emojibase-data/en/shortcodes/iamcal.json";

/**
 * `:pray:` → 🙏. Slack and GitHub both send shortcodes in message text, and a
 * card that reads "can you help? :point_up::pray:" makes you decode it.
 *
 * iamcal is the shortcode set Slack itself uses; GitHub's overlaps almost
 * entirely. ponytail: no second map for GitHub's handful of extras, and a
 * shortcode we don't know stays as typed — which is what Slack does too.
 */
const BY_SHORTCODE = new Map<string, string>(
	Object.entries(shortcodes as Record<string, string | string[]>).flatMap(
		([hexcode, names]) => {
			const emoji = hexcode
				.split("-")
				.map((point) => String.fromCodePoint(Number.parseInt(point, 16)))
				.join("");
			// Legacy BMP symbols (☝, ☀, ❤) default to the thin text glyph — the
			// variation selector is what asks for the colour emoji. Sequences
			// already carry theirs.
			const shown =
				!hexcode.includes("-") && Number.parseInt(hexcode, 16) <= 0xffff
					? `${emoji}\uFE0F`
					: emoji;
			return [names].flat().map((name) => [name, shown] as const);
		},
	),
);

export function emojify(text: string): string {
	return text.replace(
		/:([a-z0-9_+-]+):/gi,
		(match, name: string) => BY_SHORTCODE.get(name.toLowerCase()) ?? match,
	);
}
