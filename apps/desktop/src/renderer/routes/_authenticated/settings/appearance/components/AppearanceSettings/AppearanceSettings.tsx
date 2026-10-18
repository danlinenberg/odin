import { Switch } from "@odin/ui/switch";
import type { ReactNode } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useSessionView } from "renderer/stores/session-view";
import { TEXT_SIZES } from "shared/text-size";
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
	const setTextSize = electronTrpc.window.setTextSize.useMutation({
		onSuccess: (size) => utils.window.getTextSize.setData(undefined, size),
	});
	return (
		<SettingsSection title="Text">
			<SettingRow
				label="Text size"
				description="How big Odin draws its own text and controls. Pages in the in-app browser (GitHub, Jira, Notion) keep their size. ⌘+ and ⌘- still zoom everything."
			>
				<div className="flex overflow-hidden rounded-md border border-border">
					{TEXT_SIZES.map((size) => (
						<button
							key={size}
							type="button"
							aria-pressed={textSize === size}
							title={`Text size ${Math.round(size * 100)}%`}
							disabled={setTextSize.isPending}
							onClick={() => setTextSize.mutate({ size })}
							className={`px-2.5 py-1 text-xs tabular-nums ${
								textSize === size
									? "bg-primary text-primary-foreground"
									: "text-muted-foreground hover:bg-card"
							}`}
						>
							{Math.round(size * 100)}%
						</button>
					))}
				</div>
			</SettingRow>
		</SettingsSection>
	);
}
