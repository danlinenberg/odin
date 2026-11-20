/**
 * Folding a launch prompt to the request you typed. Pure, so the board's chat
 * and the iPhone app (renderer/mobile) hide Odin's part the same way.
 */

/**
 * The block heads useLaunchTaskSession, the rules store and buildThreadPrompt
 * put after a task's title and description: attachments, your context, a
 * thread task's phases, standing rules, and the closing instructions. Keep
 * these in step with those writers.
 */
const LAUNCH_SCAFFOLD =
	/^(Attached files|PHASE 1 - INGEST|Context and guidelines from me|This run was started by a schedule|Standing rules - follow each one|Work in the current workspace\.)/;

/**
 * The request you typed in a launch prompt - its title and description, without
 * the scaffolding the launcher added after them. null when there is none to fold.
 */
export function launchRequest(text: string): string | null {
	const blocks = text.split(/\n\n+/);
	const at = blocks.findIndex(
		(block, i) => i > 0 && LAUNCH_SCAFFOLD.test(block),
	);
	return at < 0 ? null : blocks.slice(0, at).join("\n\n");
}

/**
 * The files a launch prompt attached: the lines under its "Attached files"
 * head that are paths. The fold hides that block, so the bubble names them.
 */
export function launchFiles(text: string): string[] {
	const block = text
		.split(/\n\n+/)
		.find((part) => part.startsWith("Attached files"));
	return (block?.split("\n").slice(1) ?? [])
		.map((line) => line.trim())
		.filter((line) => line.startsWith("/"));
}

/** An image a message embeds as Markdown by absolute path, as a task's notes do. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\((\/[^)\s]+)\)/g;

/** The paths of the images a message embeds as Markdown. */
export function markdownImages(text: string): string[] {
	return [...text.matchAll(MARKDOWN_IMAGE)].map((match) => match[1] ?? "");
}

/** The message without its Markdown images, for a bubble that shows them as thumbnails. */
export function withoutMarkdownImages(text: string): string {
	return text
		.replace(MARKDOWN_IMAGE, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
