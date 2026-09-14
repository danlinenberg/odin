import { z } from "zod";

const persistedDateSchema = z
	.union([z.string(), z.date()])
	.transform((value) => (typeof value === "string" ? new Date(value) : value));

const v2ExecutionModeSchema = z.enum([
	"split-pane",
	"new-tab",
	"new-tab-split-pane",
	"sequential",
]);

// projectIds uses plain z.string() (not uuid) because v1 accepts arbitrary
// string IDs and the migration copies them verbatim.
export const v2TerminalPresetSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	description: z.string().optional(),
	cwd: z.string().default(""),
	commands: z.array(z.string()).default([]),
	projectIds: z.array(z.string()).nullable().default(null),
	pinnedToBar: z.boolean().optional(),
	useAsWorkspaceRun: z.boolean().optional(),
	applyOnWorkspaceCreated: z.boolean().optional(),
	applyOnNewTab: z.boolean().optional(),
	executionMode: v2ExecutionModeSchema.default("new-tab"),
	tabOrder: z.number().int().default(0),
	createdAt: persistedDateSchema,
	// When set, the preset is live-linked to a host-service agent config id.
	// Older rows may still contain a builtin preset id; the launcher/editor
	// support that as a fallback. The stored `commands` array is a snapshot
	// fallback for when the agent is missing or disabled.
	agentId: z.string().optional(),
});

export type V2TerminalPresetRow = z.infer<typeof v2TerminalPresetSchema>;

/**
 * Singleton row of v2 user-scoped preferences.
 *
 * fileLinks / urlLinks / sidebarFileLinks map click tiers
 * (plain, ⇧, ⌘, ⌘⇧) to an action:
 *   - null        → tier is unbound (surfaces show a hint or no-op)
 *   - "pane"      → open in current tab/pane (file viewer, in-app browser)
 *   - "newTab"    → open in a new tab/pane
 *   - "external"  → open in the external app (editor / system browser)
 *
 * Surfaces:
 *   - fileLinks / urlLinks: links embedded in terminal output and markdown.
 *     Terminal reads all 4 tiers; 2-tier surfaces (chat, task markdown)
 *     collapse shift→plain and metaShift→meta.
 *   - sidebarFileLinks: file rows in the sidebar (tree, changes, diff header).
 *
 * portOpenAction is a single action (not a tier map) for detected-port
 * badges: "pane" = in-app browser, "newTab" = new in-app tab,
 * "external" = system browser.
 *
 * Resolution and labels live in src/renderer/lib/clickPolicy.
 */
const linkActionSchema = z.enum(["pane", "newTab", "external"]);

export type LinkAction = z.infer<typeof linkActionSchema>;

const linkTierMapSchema = z.object({
	plain: linkActionSchema.nullable(),
	shift: linkActionSchema.nullable(),
	meta: linkActionSchema.nullable(),
	metaShift: linkActionSchema.nullable(),
});

export type LinkTierMap = z.infer<typeof linkTierMapSchema>;
export type LinkTier = keyof LinkTierMap;

const DEFAULT_LINK_TIER_MAP: LinkTierMap = {
	plain: null,
	shift: null,
	meta: "pane",
	metaShift: "external",
};

const LEGACY_SIDEBAR_FILE_LINKS: LinkTierMap = {
	plain: "pane",
	shift: "newTab",
	meta: "external",
	metaShift: "external",
};

const DEFAULT_SIDEBAR_FILE_LINKS: LinkTierMap = {
	plain: "pane",
	shift: "newTab",
	meta: "pane",
	metaShift: "external",
};

// Clicking a port badge's open affordance opens http://localhost:<port>.
// A single action chooses where: "pane" = in-app browser, "newTab" = new
// in-app tab, "external" = system browser.
const DEFAULT_PORT_OPEN_ACTION: LinkAction = "external";

function isSameLinkTierMap(a: LinkTierMap, b: LinkTierMap): boolean {
	return (
		a.plain === b.plain &&
		a.shift === b.shift &&
		a.meta === b.meta &&
		a.metaShift === b.metaShift
	);
}

function isCompleteLinkTierMap(
	value: Partial<LinkTierMap>,
): value is LinkTierMap {
	return (
		"plain" in value &&
		"shift" in value &&
		"meta" in value &&
		"metaShift" in value
	);
}

export const v2UserPreferencesSchema = z.object({
	id: z.literal("preferences"),
	fileLinks: linkTierMapSchema.default(DEFAULT_LINK_TIER_MAP),
	urlLinks: linkTierMapSchema.default(DEFAULT_LINK_TIER_MAP),
	sidebarFileLinks: linkTierMapSchema.default(DEFAULT_SIDEBAR_FILE_LINKS),
	portOpenAction: linkActionSchema.default(DEFAULT_PORT_OPEN_ACTION),
	terminalPresetsInitialized: z.boolean().default(false),
	rightSidebarOpen: z.boolean().default(true),
	rightSidebarTab: z.enum(["changes", "files"]).default("changes"),
	rightSidebarWidth: z.number().default(340),
	deleteLocalBranch: z.boolean().default(false),
	showPresetsBar: z.boolean().default(true),
});

export type V2UserPreferencesRow = z.infer<typeof v2UserPreferencesSchema>;

export const V2_USER_PREFERENCES_ID = "preferences" as const;

export const DEFAULT_V2_USER_PREFERENCES: V2UserPreferencesRow = {
	id: V2_USER_PREFERENCES_ID,
	fileLinks: DEFAULT_LINK_TIER_MAP,
	urlLinks: DEFAULT_LINK_TIER_MAP,
	sidebarFileLinks: DEFAULT_SIDEBAR_FILE_LINKS,
	portOpenAction: DEFAULT_PORT_OPEN_ACTION,
	terminalPresetsInitialized: false,
	rightSidebarOpen: true,
	rightSidebarTab: "changes",
	rightSidebarWidth: 340,
	deleteLocalBranch: false,
	showPresetsBar: true,
};

/**
 * Heal a stored v2 user-preferences row against current defaults. Used by the
 * localStorage collection's read-time parser so rows persisted before a field
 * was added (top-level or nested in a LinkTierMap) don't surface as undefined
 * to consumers. Per-tier defaults vary by map, so we deep-merge each tier map
 * against its own default rather than relying on a single Zod default.
 */
export function healV2UserPreferences(raw: unknown): V2UserPreferencesRow {
	const r = (
		raw && typeof raw === "object" ? raw : {}
	) as Partial<V2UserPreferencesRow>;
	const sidebarFileLinks = r.sidebarFileLinks
		? {
				...DEFAULT_V2_USER_PREFERENCES.sidebarFileLinks,
				...r.sidebarFileLinks,
			}
		: DEFAULT_V2_USER_PREFERENCES.sidebarFileLinks;
	const shouldMigrateLegacySidebarFileLinks =
		r.sidebarFileLinks &&
		isCompleteLinkTierMap(r.sidebarFileLinks) &&
		isSameLinkTierMap(r.sidebarFileLinks, LEGACY_SIDEBAR_FILE_LINKS);
	return {
		...DEFAULT_V2_USER_PREFERENCES,
		...r,
		fileLinks: { ...DEFAULT_V2_USER_PREFERENCES.fileLinks, ...r.fileLinks },
		urlLinks: { ...DEFAULT_V2_USER_PREFERENCES.urlLinks, ...r.urlLinks },
		sidebarFileLinks: shouldMigrateLegacySidebarFileLinks
			? DEFAULT_V2_USER_PREFERENCES.sidebarFileLinks
			: sidebarFileLinks,
	};
}
