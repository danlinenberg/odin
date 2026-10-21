import {
	type Dirent,
	existsSync,
	readdirSync,
	readFileSync,
	type Stats,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { publicProcedure, router } from "..";

/**
 * Odin fork: the skills/slash-commands a launched `claude` session can use, so
 * the session composer can search them. Read from disk in the main process -
 * the renderer has no fs, and the CLI has no "list my skills" command. The
 * skills built into Claude Code itself are on no disk at all, so they're a
 * list here (BUNDLED_SKILLS).
 */
export interface AgentSkill {
	/** What you type after the slash. Plugin skills are `plugin:skill`. */
	name: string;
	description: string;
}

function readDescription(filePath: string): string {
	try {
		const head = readFileSync(filePath, "utf-8").slice(0, 4000);
		const value = /^description:[ \t]*(.+)$/m.exec(head)?.[1] ?? "";
		return value.trim().replace(/^["']|["']$/g, "");
	} catch {
		return "";
	}
}

/** Dirent types describe a symlink itself, so follow links to their target. */
function entryStat(dir: string, entry: Dirent): Stats | Dirent | undefined {
	if (!entry.isSymbolicLink()) return entry;
	try {
		return statSync(join(dir, entry.name));
	} catch {
		return undefined;
	}
}

function subdirectories(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entryStat(path, entry)?.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function markdownFiles(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.name.endsWith(".md") && entryStat(path, entry)?.isFile(),
			)
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

export function collectSkills(options?: { homeDir?: string }): AgentSkill[] {
	const home = options?.homeDir ?? homedir();
	const found = new Map<string, AgentSkill>();
	const add = (name: string, filePath: string) => {
		// First writer wins, matching Claude Code's own precedence order.
		if (!found.has(name)) {
			found.set(name, { name, description: readDescription(filePath) });
		}
	};

	/**
	 * A plugin root: `skills/<name>/SKILL.md` and `commands/<name>.md`, or a
	 * single-skill plugin whose SKILL.md sits at the root (`<plugin>:<plugin>`).
	 */
	const addPluginRoot = (prefix: string, root: string) => {
		const rootSkill = join(root, "SKILL.md");
		if (existsSync(rootSkill)) add(`${prefix}:${prefix}`, rootSkill);
		for (const skill of subdirectories(join(root, "skills"))) {
			const skillMd = join(root, "skills", skill, "SKILL.md");
			if (existsSync(skillMd)) add(`${prefix}:${skill}`, skillMd);
		}
		for (const file of markdownFiles(join(root, "commands"))) {
			add(`${prefix}:${basename(file, ".md")}`, join(root, "commands", file));
		}
	};

	const skillsRoot = join(home, ".claude", "skills");
	for (const dir of subdirectories(skillsRoot)) {
		const skillMd = join(skillsRoot, dir, "SKILL.md");
		if (existsSync(skillMd)) {
			add(dir, skillMd);
			continue;
		}
		// A skills subdir carrying .claude-plugin/plugin.json is loaded as its own
		// plugin, namespacing everything under it as `<dir>:<name>`.
		if (existsSync(join(skillsRoot, dir, ".claude-plugin", "plugin.json"))) {
			addPluginRoot(dir, join(skillsRoot, dir));
		}
	}

	const commandsRoot = join(home, ".claude", "commands");
	for (const file of markdownFiles(commandsRoot)) {
		add(basename(file, ".md"), join(commandsRoot, file));
	}

	// Installed plugins: keys are `<plugin>@<marketplace>`, and each entry knows
	// where it was unpacked.
	try {
		const manifest = JSON.parse(
			readFileSync(
				join(home, ".claude", "plugins", "installed_plugins.json"),
				"utf-8",
			),
		) as { plugins?: Record<string, { installPath?: string }[]> };
		for (const [key, entries] of Object.entries(manifest.plugins ?? {})) {
			const plugin = key.split("@")[0];
			if (!plugin) continue;
			for (const entry of entries) {
				if (entry.installPath) addPluginRoot(plugin, entry.installPath);
			}
		}
	} catch {
		// no plugins installed, or an unreadable manifest - personal skills still work
	}

	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The skills that ship inside Claude Code (/loop, /schedule, /code-review...).
 * They live in the `claude` binary, not under ~/.claude, so the scan above
 * never sees them and typing `/loop` found nothing. The labels are Claude
 * Code's own menu descriptions. Model-only skills (artifact-design,
 * keybindings-help) are left out: a slash can't invoke them.
 */
export const BUNDLED_SKILLS: AgentSkill[] = [
	{
		name: "artifact-capabilities",
		description: "Runtime capabilities for published Artifacts",
	},
	{
		name: "artifact-diagramming",
		description: "Diagramming guidance for Artifacts",
	},
	{
		name: "claude-api",
		description: "Build and debug apps that use the Claude API",
	},
	{
		name: "claude-in-chrome",
		description: "Let Claude browse and interact with pages in your Chrome",
	},
	{
		name: "code-review",
		description: "Review the current diff or a PR for bugs and cleanups",
	},
	{ name: "dataviz", description: "Chart and dashboard design guidance" },
	{
		name: "fewer-permission-prompts",
		description: "Pre-approve safe read-only commands based on your usage",
	},
	{
		name: "init",
		description: "Initialize a new CLAUDE.md file with codebase documentation",
	},
	{
		name: "loop",
		description:
			"Repeat a prompt or command on an interval (e.g. /loop 5m /foo)",
	},
	{
		name: "plugin-authoring",
		description:
			"Write a mod: a live pane, view or behaviour change in Claude Code",
	},
	{
		name: "run",
		description: "Launch this project's app to see your change working",
	},
	{
		name: "schedule",
		description: "Create and manage routines: cloud agents on a schedule",
	},
	{
		name: "security-review",
		description:
			"Complete a security review of the pending changes on the current branch",
	},
	{
		name: "simplify",
		description: "Clean up the changed code without changing behavior",
	},
	{
		name: "update-config",
		description: "Change settings: hooks, permissions, environment variables",
	},
];

/**
 * The scanned skills plus the bundled ones the scan can't see. A skill of
 * your own with a bundled name keeps its own entry, as in Claude Code.
 */
export function withBundledSkills(skills: AgentSkill[]): AgentSkill[] {
	const names = new Set(skills.map((skill) => skill.name));
	return [
		...skills,
		...BUNDLED_SKILLS.filter((skill) => !names.has(skill.name)),
	].sort((a, b) => a.name.localeCompare(b.name));
}

export const createSkillsRouter = () => {
	return router({
		list: publicProcedure.query((): AgentSkill[] =>
			withBundledSkills(collectSkills()),
		),
	});
};
