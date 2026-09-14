import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSkills } from "./skills";

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function skillFile(description: string): string {
	return `---\nname: whatever\ndescription: ${description}\n---\n\nbody\n`;
}

test("collectSkills finds personal, skills-dir-plugin and installed-plugin skills", () => {
	const home = mkdtempSync(join(tmpdir(), "odin-skills-"));
	const claude = join(home, ".claude");

	write(join(claude, "skills", "gdpr", "SKILL.md"), skillFile("Audit tickets"));
	write(join(claude, "commands", "visualize.md"), skillFile("Draw the flow"));

	// A skills subdir that is really a plugin — namespaced `odin:*`.
	write(join(claude, "skills", "odin", ".claude-plugin", "plugin.json"), "{}");
	write(
		join(claude, "skills", "odin", "skills", "doctor", "SKILL.md"),
		skillFile("Fix Odin"),
	);
	write(
		join(claude, "skills", "odin", "commands", "standup.md"),
		skillFile("What agents did"),
	);

	// An installed plugin, located through the manifest.
	const installPath = join(home, "cache", "imagen-core", "1.0.0");
	write(
		join(installPath, "skills", "pr-iterate", "SKILL.md"),
		skillFile("Poll CI"),
	);
	write(join(installPath, "commands", "data.md"), skillFile("Query the DB"));
	write(
		join(claude, "plugins", "installed_plugins.json"),
		JSON.stringify({
			plugins: { "imagen-core@imagen-internal": [{ installPath }] },
		}),
	);

	const skills = collectSkills({ homeDir: home });

	expect(skills.map((skill) => skill.name)).toEqual([
		"gdpr",
		"imagen-core:data",
		"imagen-core:pr-iterate",
		"odin:doctor",
		"odin:standup",
		"visualize",
	]);
	expect(skills.find((skill) => skill.name === "gdpr")?.description).toBe(
		"Audit tickets",
	);
});

test("collectSkills tolerates a missing home", () => {
	expect(
		collectSkills({ homeDir: join(tmpdir(), "odin-no-such-home") }),
	).toEqual([]);
});
