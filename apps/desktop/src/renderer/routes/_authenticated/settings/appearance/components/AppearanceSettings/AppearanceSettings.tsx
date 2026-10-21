import { ODIN_REPLY_TLDR_DEFAULT } from "@odin/shared/constants";
import { Slider } from "@odin/ui/slider";
import { Switch } from "@odin/ui/switch";
import { useState } from "react";
import {
	PROVIDER_NAME,
	type Provider,
} from "renderer/components/ConnectProvider/ConnectProvider";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useInAppBrowser } from "renderer/stores/in-app-browser";
import { useSessionView } from "renderer/stores/session-view";
import { LINK_HOSTS } from "shared/in-odin-links";
import {
	DEFAULT_TEXT_SIZE,
	TEXT_SIZE_MAX,
	TEXT_SIZE_MIN,
	TEXT_SIZE_STEP,
	textSizePercent,
} from "shared/text-size";
import {
	SettingRow,
	SettingsPage,
	SettingsSection,
} from "../../../components/SettingsPage";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-items";
import { ThemeSection } from "./components/ThemeSection";

interface AppearanceSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

/**
 * Settings > Appearance: how Odin looks and how it shows things - the theme,
 * its text size, a session as a chat or a terminal, and where links open.
 */
export function AppearanceSettings({ visibleItems }: AppearanceSettingsProps) {
	const showTheme = isItemVisible(
		SETTING_ITEM_ID.APPEARANCE_THEME,
		visibleItems,
	);
	const showCustomThemes = isItemVisible(
		SETTING_ITEM_ID.APPEARANCE_CUSTOM_THEMES,
		visibleItems,
	);
	const showThemeSection = showTheme || showCustomThemes;

	return (
		<SettingsPage
			title="Appearance"
			description="How Odin looks, how a session shows in its drawer, and where links open."
		>
			{showThemeSection && (
				<SettingsSection title="Theme">
					<ThemeSection />
				</SettingsSection>
			)}
			<TextSizeSection />
			<SessionDisplaySection />
			<LinksSection />
		</SettingsPage>
	);
}

/** Odin's own text bigger or smaller, without zooming the in-app browser. */
function TextSizeSection() {
	const utils = electronTrpc.useUtils();
	const { data: textSize } = electronTrpc.window.getTextSize.useQuery();
	// Where the thumb is while it is being dragged. The zoom only applies once
	// it is let go: zooming mid-drag would move the slider under the cursor.
	const [dragged, setDragged] = useState<number | null>(null);
	const setTextSize = electronTrpc.window.setTextSize.useMutation({
		onSuccess: (size) => utils.window.getTextSize.setData(undefined, size),
		onSettled: () => setDragged(null),
	});
	const percent = textSizePercent(dragged ?? textSize ?? DEFAULT_TEXT_SIZE);
	return (
		<SettingsSection title="Text">
			<SettingRow
				label="Text size"
				description="How big Odin draws its own text and controls. Pages in the in-app browser (GitHub, Jira, Notion) keep their size. ⌘+ and ⌘- still zoom everything."
			>
				<Slider
					aria-label="Text size"
					className="w-40"
					min={textSizePercent(TEXT_SIZE_MIN)}
					max={textSizePercent(TEXT_SIZE_MAX)}
					step={textSizePercent(TEXT_SIZE_STEP)}
					value={[percent]}
					onValueChange={([value]) => setDragged(value / 100)}
					onValueCommit={([value]) => setTextSize.mutate({ size: value / 100 })}
				/>
				<span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
					{percent}%
				</span>
			</SettingRow>
		</SettingsSection>
	);
}

/** How a session shows in its drawer: a chat, or its terminal. */
function SessionDisplaySection() {
	const chat = useSessionView((s) => s.chat);
	const setChat = useSessionView((s) => s.setChat);
	return (
		<SettingsSection
			title="Sessions"
			description="How a session shows in its drawer."
		>
			<SettingRow
				label="Show sessions as a chat"
				htmlFor="session-chat-view"
				description="Show a session like Claude Code in the Claude desktop app - messages, folded tool calls and a reply box - instead of its terminal. Same session behind it; a question or plan approval still opens the terminal."
			>
				<Switch
					id="session-chat-view"
					checked={chat}
					onCheckedChange={setChat}
				/>
			</SettingRow>
			<ReplyTldrRow />
		</SettingsSection>
	);
}

/** Whether a long latest reply folds under its TL;DR in the chat view. */
function ReplyTldrRow() {
	const utils = electronTrpc.useUtils();
	const { data: enabled, isLoading } =
		electronTrpc.settings.getOdinReplyTldr.useQuery();
	const setEnabled = electronTrpc.settings.setOdinReplyTldr.useMutation({
		onMutate: async ({ enabled }) => {
			await utils.settings.getOdinReplyTldr.cancel();
			const previous = utils.settings.getOdinReplyTldr.getData();
			utils.settings.getOdinReplyTldr.setData(undefined, enabled);
			return { previous };
		},
		onError: (_err, _vars, context) => {
			if (context?.previous !== undefined) {
				utils.settings.getOdinReplyTldr.setData(undefined, context.previous);
			}
		},
		onSettled: () => utils.settings.getOdinReplyTldr.invalidate(),
	});

	return (
		<SettingRow
			label="Fold long replies"
			htmlFor="reply-tldr"
			description="A latest reply too long for the window folds under its TL;DR card, with a Show full reply link. Off shows the reply whole above the TL;DR."
		>
			<Switch
				id="reply-tldr"
				checked={enabled ?? ODIN_REPLY_TLDR_DEFAULT}
				onCheckedChange={(enabled) => setEnabled.mutate({ enabled })}
				disabled={isLoading || setEnabled.isPending}
			/>
		</SettingRow>
	);
}

/** Every provider names its link hosts, so a new one gets its switch below. */
const PROVIDER_LINK_HOSTS: Record<Provider, readonly string[]> = LINK_HOSTS;
const LINK_PROVIDERS = (
	["slack", "github", "jira", "notion", "gmail", "clickup"] as const
).filter((p) => PROVIDER_LINK_HOSTS[p].length > 0);
const linkSiteNames = LINK_PROVIDERS.map((p) => PROVIDER_NAME[p]);
const LINK_SITE_LIST = `${linkSiteNames.slice(0, -1).join(", ")} and ${linkSiteNames.at(-1)}`;

/**
 * Undoes "Always open links in your browser" from the in-app browser; while
 * it's on, each site can still send its own links to your browser.
 */
function LinksSection() {
	const external = useInAppBrowser((state) => state.external);
	const browserSites = useInAppBrowser((state) => state.browserSites);
	return (
		<SettingsSection
			title="Links"
			description="Where a link from a task opens: in a panel over the page, or in your browser."
		>
			<SettingRow
				label="Open links inside Odin"
				htmlFor="open-links-in-odin"
				description={`${LINK_SITE_LIST} links open in a panel over the page instead of another app; other links always go to your default browser. Off sends them all there.`}
			>
				<Switch
					id="open-links-in-odin"
					checked={!external}
					onCheckedChange={(inOdin) =>
						useInAppBrowser.setState({ external: !inOdin })
					}
				/>
			</SettingRow>
			{!external &&
				LINK_PROVIDERS.map((id) => (
					<SettingRow
						key={id}
						label={`${PROVIDER_NAME[id]} links`}
						htmlFor={`open-links-in-odin-${id}`}
					>
						<Switch
							id={`open-links-in-odin-${id}`}
							checked={!browserSites.includes(id)}
							onCheckedChange={(inOdin) =>
								useInAppBrowser.setState({
									browserSites: inOdin
										? browserSites.filter((site) => site !== id)
										: [...browserSites, id],
								})
							}
						/>
					</SettingRow>
				))}
		</SettingsSection>
	);
}
