/**
 * CI's guide check: Huginn answers every question about Odin from the guide
 * (src/shared/odin-guide.ts), so a feature the guide leaves out is one he says
 * Odin doesn't have. This asks Claude whether the PR's diff adds or changes
 * something a user can see that the guide doesn't cover, or makes a line of
 * the guide untrue, and fails the PR with what to add when it does.
 *
 * The drift tests (odin-guide-coverage.test.ts) catch lists that drift - a new
 * tab, rail entry or setting. This catches the rest: what a feature does.
 *
 * Passes without a check when there is nothing to compare: a push to main, a
 * PR that doesn't touch the app's source, or no ANTHROPIC_API_KEY (PRs from
 * forks get no secrets).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const GUIDE_PATH = "apps/desktop/src/shared/odin-guide.ts";
/** Past this the diff is too big to judge in one call; the job says so instead of guessing. */
const MAX_DIFF_CHARS = 600_000;

const warn = (message: string) => console.log(`::warning::${message}`);

const base = process.env.GITHUB_BASE_REF;
if (!base) {
	console.log("Not a pull request - nothing to compare.");
	process.exit(0);
}

const git = (...args: string[]) =>
	execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });

const diff = git(
	"diff",
	`origin/${base}...HEAD`,
	"--",
	"apps/desktop/src",
	`:!${GUIDE_PATH}`,
	":!**/*.test.ts",
	":!**/*.test.tsx",
);
if (!diff.trim()) {
	console.log("The PR doesn't change the app's source - nothing to check.");
	process.exit(0);
}
if (diff.length > MAX_DIFF_CHARS) {
	warn(
		`Diff is ${diff.length} characters, over ${MAX_DIFF_CHARS}: too big for the guide check. Check the guide by hand.`,
	);
	process.exit(0);
}
if (!process.env.ANTHROPIC_API_KEY) {
	warn("No ANTHROPIC_API_KEY secret - the guide check didn't run.");
	process.exit(0);
}

const guide = readFileSync(GUIDE_PATH, "utf8");

const SYSTEM = `Odin is a desktop app. Huginn, its built-in assistant, answers every question about Odin only from the guide below, so anything the guide leaves out is something Huginn tells users Odin doesn't have, and anything it says wrong he repeats.

You review one pull request's diff against that guide. Report a gap only when the diff:
- adds something a user can see or use (a screen, tab, button, menu item, setting, connection, automation, notification, hotkey, or something Huginn can now do) that the guide doesn't mention, or
- changes how such a thing behaves, a default value, or a label, so that a sentence in the guide is now false or misses the change.

Not gaps: refactors, renames in code, tests, styling, performance, logging, error handling, internal plumbing, and fixes that make Odin do what the guide already says. When unsure whether users would notice, it is not a gap. Never ask for code details in the guide: it describes Odin in the words the user sees.

For each gap, name the guide section it belongs in (its "## " heading, or a new one) and write the sentence to add or the corrected sentence, in the guide's style: plain, short, the labels as they appear on screen.`;

const client = new Anthropic();
const response = await client.beta.messages.create({
	model: "claude-opus-5-5",
	max_tokens: 16000,
	betas: ["server-side-fallback-2026-07-01"],
	fallbacks: "default",
	system: SYSTEM,
	output_config: {
		format: {
			type: "json_schema",
			schema: {
				type: "object",
				properties: {
					gaps: {
						type: "array",
						items: {
							type: "object",
							properties: {
								feature: { type: "string" },
								section: { type: "string" },
								sentence: { type: "string" },
							},
							required: ["feature", "section", "sentence"],
							additionalProperties: false,
						},
					},
				},
				required: ["gaps"],
				additionalProperties: false,
			},
		},
	},
	messages: [
		{
			role: "user",
			content: `<guide>\n${guide}\n</guide>\n\n<diff>\n${diff}\n</diff>`,
		},
	],
});

if (response.stop_reason === "refusal") {
	warn("Claude declined to review this diff - the guide check didn't run.");
	process.exit(0);
}
const text = response.content.find((block) => block.type === "text");
if (!text || text.type !== "text") {
	warn(
		`The guide check got no answer (stop reason ${response.stop_reason}) - it didn't run.`,
	);
	process.exit(0);
}

const { gaps } = JSON.parse(text.text) as {
	gaps: { feature: string; section: string; sentence: string }[];
};
if (!gaps.length) {
	console.log("The guide covers this PR.");
	process.exit(0);
}

console.log(
	`The Odin guide (${GUIDE_PATH}) doesn't cover ${gaps.length} change(s) in this PR. Huginn answers from it, so add these and push again:\n`,
);
for (const gap of gaps) {
	console.log(`::error file=${GUIDE_PATH}::${gap.feature}`);
	console.log(
		`- ${gap.feature}\n  Section: ${gap.section}\n  Add: ${gap.sentence}\n`,
	);
}
process.exit(1);
