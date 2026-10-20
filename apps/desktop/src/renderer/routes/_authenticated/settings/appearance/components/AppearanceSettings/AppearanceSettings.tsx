import { Slider } from "@odin/ui/slider";
import { Switch } from "@odin/ui/switch";
import { type ReactNode, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useSessionView } from "renderer/stores/session-view";
import {
	DEFAULT_TEXT_SIZE,
	TEXT_SIZE_MAX,
	TEXT_SIZE_MIN,
	TEXT_SIZE_STEP,
	textSizePercent,
} from "shared/text-size";
import { SettingRow, SettingsSection } from "../../../components/SettingsPage";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-items";
import { ThemeSection } from "./components/ThemeSection";

/**
 * Renders a list of visible sections with automatic border separators.
 * Each section is its own component that owns its data-fetching,
 * so query resolutions in one section don't re-render others.
 */
function SectionList({ children }: { children: ReactNode[] }) {
	const visibleChildren = children.filter(Boolean);
	return (
		<div className="space-y-6">
			{visibleChildren.map((child, i) => (
				<div key={(child as React.ReactElement).key ?? i}>{child}</div>
			))}
		</div>
	);
}

interface AppearanceSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

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
		<div className="p-6 max-w-5xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Appearance</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Customize how Odin looks on your device
				</p>
			</div>

			<SectionList>
				{showThemeSection && <ThemeSection key="theme" />}
				<TextSizeSection key="text-size" />
				<SessionDisplaySection key="sessions" />
			</SectionList>
		</div>
	);
}

/** How a session shows in its drawer: a chat, or its terminal. */
function SessionDisplaySection() {
	const chat = useSessionView((s) => s.chat);
	const setChat = useSessionView((s) => s.setChat);
	return (
		<SettingsSection title="Sessions">
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
		</SettingsSection>
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
