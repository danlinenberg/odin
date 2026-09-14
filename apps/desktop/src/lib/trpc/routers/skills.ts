import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { publicProcedure, router } from "..";

/**
 * Odin fork: the skills/slash-commands a launched `claude` session can use, so
 * the session composer can search them. Read from disk in the main process —
 * the renderer has no fs, and the CLI has no "list my skills" command.
 */
export interface AgentSkill {
	/** What you type after the slash. Plugin skills are `plugin:skill`. */
	name: string;
	description: string;
}

/**
 * ponytail: first line of the frontmatter `description:` only — a folded
 * multi-line YAML description gets truncated. Enough for a picker row.
 */
function readDescription(filePath: string): string {
	try {
		const head = readFileSync(filePath, "utf-8").slice(0, 4000);
		const value = /^description:[ \t]*(.+)$/m.exec(head)?.[1] ?? "";
		return value.trim().replace(/^["']|["']$/g, "");
	} catch {
		return "";
	}
}

function subdirectories(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/** ponytail: top-level *.md only — nested command namespaces aren't used here. */
function markdownFiles(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
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

	/** A plugin root: `skills/<name>/SKILL.md` and `commands/<name>.md`. */
	const addPluginRoot = (prefix: string, root: string) => {
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
		// no plugins installed, or an unreadable manifest — personal skills still work
	}

	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const createSkillsRouter = () => {
	return router({
		list: publicProcedure.query((): AgentSkill[] => collectSkills()),
	});
};
