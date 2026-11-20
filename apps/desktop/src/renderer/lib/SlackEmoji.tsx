import { electronTrpc } from "renderer/lib/electron-trpc";
import { emojify } from "renderer/lib/emoji";

/**
 * One Slack reaction name drawn as Slack draws it: a standard emoji as the
 * character, a workspace custom emoji (`dancing-odin`) as its image, and
 * anything else as `:name:`.
 */
export function SlackEmoji({ name }: { name: string }) {
	const { data: custom } = electronTrpc.slack.customEmoji.useQuery(undefined, {
		staleTime: 10 * 60_000,
	});
	const shortcode = `:${name}:`;
	const shown = emojify(shortcode);
	const url = shown === shortcode ? custom?.[name] : undefined;
	return url ? (
		<img
			src={url}
			alt={shortcode}
			className="inline-block size-[1.2em] align-[-0.2em] object-contain"
		/>
	) : (
		shown
	);
}
