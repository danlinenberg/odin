import { tmpdir } from "node:os";
import { execWithShellEnv } from "lib/trpc/routers/workspaces/utils/shell-env";

/** One installed plugin, as `claude plugin list --json` prints it. */
interface InstalledPlugin {
	id: string;
	version?: string;
	scope?: string;
	enabled?: boolean;
}

/** What Update plugins did to one plugin. */
export interface PluginUpdate {
	/** `plugin@marketplace`. */
	id: string;
	from: string;
	/** The version after the update, the same as `from` when it was latest. */
	to: string;
	/** Why the CLI refused, e.g. a marketplace command that needs a person. */
	error?: string;
}

export interface PluginUpdateResult {
	plugins: PluginUpdate[];
	/** Set when refreshing the marketplaces failed: the versions may be stale. */
	marketplaceError?: string;
}

export type ClaudeRun = (args: string[]) => Promise<string>;

const runClaude: ClaudeRun = async (args) =>
	(
		await execWithShellEnv("claude", args, {
			cwd: tmpdir(),
			timeout: 120_000,
			maxBuffer: 8 * 1024 * 1024,
		})
	).stdout;

/** The CLI's own words for a failure: its last stderr line, else the error. */
function reason(error: unknown): string {
	const stderr = (error as { stderr?: unknown }).stderr;
	const text = typeof stderr === "string" ? stderr.trim() : "";
	const line = text.split("\n").filter(Boolean).at(-1);
	return line ?? (error instanceof Error ? error.message : String(error));
}

async function listUserPlugins(run: ClaudeRun): Promise<InstalledPlugin[]> {
	const list = JSON.parse(await run(["plugin", "list", "--json"])) as unknown;
	if (!Array.isArray(list)) return [];
	return (list as InstalledPlugin[]).filter(
		(plugin) =>
			typeof plugin.id === "string" &&
			plugin.enabled !== false &&
			(plugin.scope ?? "user") === "user",
	);
}

/**
 * Settings > Advanced > Update plugins: refresh every marketplace, then move
 * each enabled user plugin to its newest version, the way Claude Code's
 * `/plugin` does one at a time. Project and managed plugins are left alone:
 * they belong to a repo or to an admin. One plugin at a time, since each
 * update rewrites the same installed_plugins.json. Versions are read from
 * `plugin list` before and after, so the result says what really changed.
 */
export async function updatePlugins(
	run: ClaudeRun = runClaude,
): Promise<PluginUpdateResult> {
	let marketplaceError: string | undefined;
	try {
		await run(["plugin", "marketplace", "update"]);
	} catch (error) {
		marketplaceError = reason(error);
	}

	const before = await listUserPlugins(run);
	const errors = new Map<string, string>();
	for (const plugin of before) {
		try {
			await run(["plugin", "update", plugin.id, "--scope", "user"]);
		} catch (error) {
			errors.set(plugin.id, reason(error));
		}
	}

	const after = new Map(
		(await listUserPlugins(run)).map((plugin) => [plugin.id, plugin.version]),
	);
	const plugins = before.map((plugin): PluginUpdate => {
		const from = plugin.version ?? "";
		const error = errors.get(plugin.id);
		return {
			id: plugin.id,
			from,
			to: after.get(plugin.id) ?? from,
			...(error ? { error } : {}),
		};
	});
	return { plugins, ...(marketplaceError ? { marketplaceError } : {}) };
}
