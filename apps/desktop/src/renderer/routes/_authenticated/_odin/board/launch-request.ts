/**
 * Folding a launch prompt to the request you typed. Pure, so the board's chat
 * and the iPhone app (renderer/mobile) hide Odin's part the same way.
 */

/**
 * The block heads useLaunchTaskSession and the rules store put after a task's
 * title and description: attachments, your context, standing rules, and the
 * closing instructions. Keep these in step with those writers.
 */
const LAUNCH_SCAFFOLD =
	/^(Attached files|Context and guidelines from me|This run was started by a schedule|Standing rules - follow each one|Work in the current workspace\.)/;

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
