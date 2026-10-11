import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

	// A skills subdir that is really a plugin - namespaced `odin:*`.
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

test("collectSkills follows symlinked skill dirs and command files", () => {
	const home = mkdtempSync(join(tmpdir(), "odin-skills-"));
	const claude = join(home, ".claude");
	const shared = join(home, "repo");

	write(join(shared, "aidev-jira-tickets", "SKILL.md"), skillFile("Tickets"));
	write(join(shared, "triage.md"), skillFile("Triage"));
	mkdirSync(join(claude, "skills"), { recursive: true });
	mkdirSync(join(claude, "commands"), { recursive: true });
	symlinkSync(
		join(shared, "aidev-jira-tickets"),
		join(claude, "skills", "aidev-jira-tickets"),
	);
	symlinkSync(join(shared, "triage.md"), join(claude, "commands", "triage.md"));
	symlinkSync(join(shared, "gone"), join(claude, "skills", "broken"));

	expect(collectSkills({ homeDir: home })).toEqual([
		{ name: "aidev-jira-tickets", description: "Tickets" },
		{ name: "triage", description: "Triage" },
	]);
});

test("collectSkills tolerates a missing home", () => {
	expect(
		collectSkills({ homeDir: join(tmpdir(), "odin-no-such-home") }),
	).toEqual([]);
});

test("collectSkills finds a single-skill plugin whose SKILL.md is at its root", () => {
	const home = mkdtempSync(join(tmpdir(), "odin-skills-"));
	const installPath = join(home, "cache", "get-pr-approved", "1.0.0");
	write(join(installPath, "SKILL.md"), skillFile("Get it approved"));
	write(
		join(home, ".claude", "plugins", "installed_plugins.json"),
		JSON.stringify({
			plugins: { "get-pr-approved@imagen-skills": [{ installPath }] },
		}),
	);

	expect(collectSkills({ homeDir: home })).toEqual([
		{ name: "get-pr-approved:get-pr-approved", description: "Get it approved" },
	]);
});
