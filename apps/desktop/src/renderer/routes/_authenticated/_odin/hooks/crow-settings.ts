import {
	ODIN_AUTO_RENAME_SESSIONS_DEFAULT,
	ODIN_REPLY_TLDR_DEFAULT,
} from "@odin/shared/constants";
import { toast } from "@odin/ui/sonner";
import type { electronTrpc } from "renderer/lib/electron-trpc";
import { useGsdLimits } from "renderer/stores/gsd-limits";
import { useGsdModeEnabled } from "renderer/stores/gsd-mode-enabled";
import { useIdleClose } from "renderer/stores/idle-close";
import { useIdleCompact } from "renderer/stores/idle-compact";
import { useInAppBrowser } from "renderer/stores/in-app-browser";
import { useLaunchLimits } from "renderer/stores/launch-limits";
import {
	MAX_NIGHT_SESSIONS,
	useNextInLinePrompt,
} from "renderer/stores/next-in-line-prompt";
import { useSessionView } from "renderer/stores/session-view";
import { SYSTEM_THEME_ID, useThemeStore } from "renderer/stores/theme/store";
import { useTodayOverview } from "renderer/stores/today-overview";
import type { LaunchLimits } from "shared/machine-load";
import {
	DEFAULT_TEXT_SIZE,
	TEXT_SIZE_MAX,
	TEXT_SIZE_MIN,
	TEXT_SIZE_STEP,
	textSizePercent,
} from "shared/text-size";
import {
	SETTINGS_INDEX,
	screenLabel,
} from "../../settings/components/SettingsSidebar/settings-index";
import { useReminders } from "../components/Reminders";
import {
	changeSetting,
	type HuginnSetting,
	listSettings,
	type SettingsContext,
} from "./crow-settings-core";
import { useBacklogReview } from "./useBacklogReview";

type Utils = ReturnType<typeof electronTrpc.useUtils>;

const SYSTEM_THEME_NAME = "Follow the system";

/** A theme's id from the name Settings shows, and back. */
function themeNames(): { id: string; name: string }[] {
	return [
		{ id: SYSTEM_THEME_ID, name: SYSTEM_THEME_NAME },
		...useThemeStore.getState().getAllThemes(),
	];
}

const launchLimit = (
	label: string,
	field: Exclude<keyof LaunchLimits, "oneSessionPerCheckout">,
	min: number,
	max: number,
	step: number,
	unit: string,
): HuginnSetting => ({
	label,
	kind: { type: "number", min, max, step, unit },
	read: () => useLaunchLimits.getState()[field],
	write: (value) =>
		useLaunchLimits.getState().setLimits({ [field]: value as number }),
});

const gsdLimit = (
	label: string,
	kind: "merge" | "destructive" | "sensitive",
): HuginnSetting => ({
	label,
	kind: { type: "switch" },
	read: () => useGsdLimits.getState()[kind],
	write: (value) => useGsdLimits.getState().set(kind, value as boolean),
	asksFirst: true,
	shown: () => useGsdModeEnabled.getState().enabled,
});

/**
 * The settings Huginn may change, by their label in Settings. Each one writes
 * through the same store or call its row's control uses, and refreshes what
 * the window shows, so it takes effect at once like a click there. Left out on
 * purpose: sign-ins, connections and tokens, the remote host and phone,
 * auto-start, the Claude command and prompts, shortcuts and backups.
 */
export function huginnSettings(utils: Utils): HuginnSetting[] {
	return [
		// Appearance
		{
			label: "Theme",
			kind: {
				type: "choice",
				choices: () => themeNames().map((theme) => theme.name),
			},
			read: () => {
				const id = useThemeStore.getState().activeThemeId;
				return themeNames().find((theme) => theme.id === id)?.name ?? id;
			},
			write: (value) => {
				const theme = themeNames().find((t) => t.name === value);
				if (theme) useThemeStore.getState().setTheme(theme.id);
			},
		},
		{
			label: "Text size",
			kind: {
				type: "number",
				min: textSizePercent(TEXT_SIZE_MIN),
				max: textSizePercent(TEXT_SIZE_MAX),
				step: textSizePercent(TEXT_SIZE_STEP),
				unit: "%",
			},
			read: async () =>
				textSizePercent(
					(await utils.client.window.getTextSize.query()) ?? DEFAULT_TEXT_SIZE,
				),
			write: async (value) => {
				const size = await utils.client.window.setTextSize.mutate({
					size: (value as number) / 100,
				});
				utils.window.getTextSize.setData(undefined, size);
			},
		},
		{
			label: "Show sessions as a chat",
			kind: { type: "switch" },
			read: () => useSessionView.getState().chat,
			write: (value) => useSessionView.getState().setChat(value as boolean),
		},
		{
			label: "Fold long replies",
			kind: { type: "switch" },
			read: async () =>
				(await utils.client.settings.getOdinReplyTldr.query()) ??
				ODIN_REPLY_TLDR_DEFAULT,
			write: async (value) => {
				await utils.client.settings.setOdinReplyTldr.mutate({
					enabled: value as boolean,
				});
				await utils.settings.getOdinReplyTldr.invalidate();
			},
		},
		{
			label: "Open links inside Odin",
			kind: { type: "switch" },
			read: () => !useInAppBrowser.getState().external,
			write: (value) => useInAppBrowser.setState({ external: !value }),
		},
		// Sessions
		launchLimit(
			"Hold new sessions when this computer is",
			"hostCpuPercent",
			1,
			100,
			1,
			"% busy",
		),
		launchLimit(
			"Hold new sessions when free memory is under",
			"minFreeMemoryGb",
			0,
			64,
			0.5,
			"GB",
		),
		launchLimit(
			"Hold new sessions when free disk is under",
			"minFreeDiskGb",
			0,
			500,
			1,
			"GB free",
		),
		launchLimit(
			"Hold new sessions when this many are working",
			"maxWorkingAgents",
			0,
			50,
			1,
			"sessions",
		),
		{
			label: "One session per repo at a time",
			kind: { type: "switch" },
			read: () => useLaunchLimits.getState().oneSessionPerCheckout !== false,
			write: (value) =>
				useLaunchLimits
					.getState()
					.setLimits({ oneSessionPerCheckout: value as boolean }),
		},
		{
			label: "Rename sessions automatically",
			kind: { type: "switch" },
			read: async () =>
				(await utils.client.settings.getOdinAutoRenameSessions.query()) ??
				ODIN_AUTO_RENAME_SESSIONS_DEFAULT,
			write: async (value) => {
				await utils.client.settings.setOdinAutoRenameSessions.mutate({
					enabled: value as boolean,
				});
				await utils.settings.getOdinAutoRenameSessions.invalidate();
			},
		},
		{
			label: "Show Today every morning",
			kind: { type: "switch" },
			read: () => useTodayOverview.getState().enabled,
			write: (value) =>
				useTodayOverview.getState().setEnabled(value as boolean),
		},
		{
			label: "Compact conversations moved to Idle",
			kind: { type: "switch" },
			read: () => useIdleCompact.getState().enabled,
			write: (value) => useIdleCompact.getState().setEnabled(value as boolean),
		},
		{
			label: "Close idle sessions after",
			kind: { type: "number", min: 0, max: 168, step: 0.5, unit: "hours" },
			read: () => useIdleClose.getState().hours,
			write: (value) => useIdleClose.getState().setHours(value as number),
		},
		gsdLimit("Merge pull requests", "merge"),
		gsdLimit("Delete and overwrite", "destructive"),
		gsdLimit("Touch credentials and permissions", "sensitive"),
		// Personalization
		{
			label: "Write drafts in my voice",
			kind: { type: "switch" },
			read: async () => (await utils.client.voice.get.query()).enabled,
			write: async (value) => {
				await utils.client.voice.setEnabled.mutate({
					enabled: value as boolean,
				});
				await utils.voice.get.invalidate();
			},
		},
		{
			label: "Let sessions send Slack messages",
			kind: { type: "switch" },
			read: () => utils.client.slack.sendAllowed.query(),
			write: async (value) => {
				await utils.client.slack.setSendAllowed.mutate({
					allowed: value as boolean,
				});
				await utils.slack.sendAllowed.invalidate();
			},
			asksFirst: true,
		},
		// Storage
		{
			label: "Delete worktrees when their PR merges",
			kind: { type: "switch" },
			read: () => utils.client.repos.getPruneMerged.query(),
			write: async (value) => {
				await utils.client.repos.setPruneMerged.mutate({
					enabled: value as boolean,
				});
				await utils.repos.getPruneMerged.invalidate();
			},
		},
		// Backlog & Night Agent
		{
			label: "Pin overdue tasks for",
			kind: { type: "number", min: 0, max: 3650, step: 1, unit: "days" },
			read: () => useNextInLinePrompt.getState().pinOverdueDays,
			write: (value) =>
				useNextInLinePrompt.getState().setPinOverdueDays(value as number),
		},
		{
			label: "Work the backlog overnight",
			kind: { type: "switch" },
			read: () => useNextInLinePrompt.getState().offHours.enabled,
			write: (value) =>
				useNextInLinePrompt
					.getState()
					.setOffHours({ enabled: value as boolean }),
			asksFirst: true,
		},
		{
			label: "At most",
			kind: {
				type: "number",
				min: 1,
				max: MAX_NIGHT_SESSIONS,
				step: 1,
				unit: "sessions a night",
			},
			read: () => useNextInLinePrompt.getState().offHours.maxSessions,
			write: (value) =>
				useNextInLinePrompt
					.getState()
					.setOffHours({ maxSessions: value as number }),
		},
		{
			label: "Sweep the backlog every",
			kind: { type: "number", min: 0, max: 168, step: 0.5, unit: "hours" },
			read: () => useBacklogReview.getState().sweepEveryHours,
			write: (value) =>
				useBacklogReview.getState().setSweepEveryHours(value as number),
		},
		// Notifications
		{
			label: "Sound",
			kind: { type: "switch" },
			read: async () =>
				!(await utils.client.settings.getNotificationSoundsMuted.query()),
			write: async (value) => {
				await utils.client.settings.setNotificationSoundsMuted.mutate({
					muted: !value,
				});
				await utils.settings.getNotificationSoundsMuted.invalidate();
			},
		},
		{
			label: "Volume",
			kind: { type: "number", min: 0, max: 100, step: 1, unit: "%" },
			read: () => utils.client.settings.getNotificationVolume.query(),
			write: async (value) => {
				await utils.client.settings.setNotificationVolume.mutate({
					volume: value as number,
				});
				await utils.settings.getNotificationVolume.invalidate();
			},
		},
		{
			label: "Notify at",
			kind: { type: "time" },
			read: () => useReminders.getState().notifyAt,
			write: (value) => useReminders.getState().setNotifyAt(value as string),
		},
	];
}

/** Settings → Appearance › Links, from the search index the sidebar uses. */
export function whereIs(label: string): string {
	const entry = SETTINGS_INDEX.find((e) => e.label === label);
	return entry
		? `Settings → ${screenLabel(entry.to)} › ${entry.section}`
		: "Settings";
}

/** Asks in the window with Allow / Don't allow; no answer in 25s is a no. */
function confirmInWindow(question: string): Promise<boolean> {
	return new Promise((resolve) => {
		let answered = false;
		const answer = (yes: boolean) => {
			if (answered) return;
			answered = true;
			resolve(yes);
		};
		toast(question, {
			description: "Nothing changes unless you allow it.",
			duration: 25_000,
			action: { label: "Allow", onClick: () => answer(true) },
			cancel: { label: "Don't allow", onClick: () => answer(false) },
			onDismiss: () => answer(false),
			onAutoClose: () => answer(false),
		});
		// The /odin call gives up at 30s, so answer before it does.
		setTimeout(() => answer(false), 26_000);
	});
}

const context = (utils: Utils): SettingsContext => ({
	settings: huginnSettings(utils),
	whereIs,
	confirm: confirmInWindow,
	announce: (text) => toast.success(text),
});

/** action=settings */
export const readSettings = (utils: Utils, args: Record<string, string>) =>
	listSettings(context(utils), args.q);

/** action=setting */
export const writeSetting = (utils: Utils, args: Record<string, string>) =>
	changeSetting(context(utils), args);
