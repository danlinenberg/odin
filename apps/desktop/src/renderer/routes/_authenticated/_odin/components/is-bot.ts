/** Renovate/dependabot/CI accounts - noise in a review queue. */
export const isBot = (author: string) =>
	/\[bot\]$|^(renovate|dependabot)/i.test(author);
