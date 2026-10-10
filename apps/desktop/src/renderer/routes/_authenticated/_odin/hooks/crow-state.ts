import { useChatPreferencesStore } from "renderer/stores/chat-preferences/store";
import { useClaudeCommand } from "renderer/stores/claude-command";
import { useDoneStore } from "renderer/stores/done";
import { useIdleClose } from "renderer/stores/idle-close";
import { useInAppBrowser } from "renderer/stores/in-app-browser";
import { useLaunchLimits } from "renderer/stores/launch-limits";
import { useMarkdownPreferencesStore } from "renderer/stores/markdown-preferences/store";
import { useNextInLinePrompt } from "renderer/stores/next-in-line-prompt";
import { useOdinRules } from "renderer/stores/odin-rules";
import { useSeenEmails } from "renderer/stores/seen-emails";
import { useSessionInstructions } from "renderer/stores/session-instructions";
import { useSessionView } from "renderer/stores/session-view";
import { useSettingsStore } from "renderer/stores/settings-state";
import { useSidebarStore } from "renderer/stores/sidebar-state";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useThemeStore } from "renderer/stores/theme/store";
import { useTitleOverrides } from "../all/title-overrides";
import { useReminders } from "../components/Reminders";
import { useBacklogReview } from "./useBacklogReview";
import { useOdinTasks } from "./useOdinTasks";

/**
 * The board's own state - settings, backlog, rules, reminders, sessions -
 * which lives in the renderer, so the raven reads and changes it here. Main's
 * operations go through action=api / action=call instead.
 */
type Store = {
	getState: () => object;
	setState: (partial: Record<string, unknown>) => void;
};
const STORES: Record<string, Store> = {
	nightAgent: useNextInLinePrompt,
	tasks: useOdinTasks,
	backlogReview: useBacklogReview,
	reminders: useReminders,
	rules: useOdinRules,
	sessionInstructions: useSessionInstructions,
	launchLimits: useLaunchLimits,
	claudeCommand: useClaudeCommand,
	done: useDoneStore,
	idleClose: useIdleClose,
	seenEmails: useSeenEmails,
	titleOverrides: useTitleOverrides,
	sessionView: useSessionView,
	chatPreferences: useChatPreferencesStore,
	markdownPreferences: useMarkdownPreferencesStore,
	inAppBrowser: useInAppBrowser,
	settingsScreen: useSettingsStore,
	sidebar: useSidebarStore,
	theme: useThemeStore,
	sessions: useTabsStore,
} as unknown as Record<string, Store>;

const MAX_REPLY = 30_000;
const clip = (text: string) =>
	text.length > MAX_REPLY
		? `${text.slice(0, MAX_REPLY)}\n... cut at ${MAX_REPLY} characters - read one field with key=.`
		: text;

/** State without its setter functions. */
const dataOf = (store: Store) =>
	Object.fromEntries(
		Object.entries(store.getState()).filter(
			([, value]) => typeof value !== "function",
		),
	);

const isPlain = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** Objects merge key by key, so `{"offHours":{"enabled":true}}` keeps the rest. */
const merge = (base: unknown, patch: unknown): unknown =>
	isPlain(base) && isPlain(patch)
		? Object.fromEntries(
				[...new Set([...Object.keys(base), ...Object.keys(patch)])].map(
					(key) => [
						key,
						key in patch ? merge(base[key], patch[key]) : base[key],
					],
				),
			)
		: patch;

/** action=state: the store names, or one store's data (or one `key` of it). */
export function readState(args: Record<string, string>): string {
	if (!args.store)
		return `Stores: ${Object.keys(STORES).join(", ")}. Read one with store=<name>.`;
	const store = STORES[args.store];
	if (!store) return `No store "${args.store}".`;
	const data = dataOf(store);
	return clip(
		JSON.stringify(args.key ? data[args.key] : data, null, 1) ?? "undefined",
	);
}

/** action=set: merge `patch` (JSON) into a store - what its screen's controls do. */
export function writeState(args: Record<string, string>): string {
	const store = STORES[args.store ?? ""];
	if (!store) return `No store "${args.store}" - list them with action=state.`;
	let patch: unknown;
	try {
		patch = JSON.parse(args.patch ?? "");
	} catch {
		return "patch must be JSON.";
	}
	if (!isPlain(patch)) return "patch must be a JSON object.";
	const data = dataOf(store);
	const unknownKeys = Object.keys(patch).filter((key) => !(key in data));
	if (unknownKeys.length)
		return `${args.store} has no ${unknownKeys.join(", ")} - read it with action=state.`;
	store.setState(merge(data, patch) as Record<string, unknown>);
	return `Updated ${args.store}: ${Object.keys(patch).join(", ")}.`;
}
