/** A turn's steps in words: what each tool call does, the time, the tokens. Pure, so the board and the phone label a turn alike. */

function toolSummary(input: Record<string, unknown>): string {
	for (const key of [
		"command",
		"file_path",
		"pattern",
		"description",
		"url",
		"query",
		"prompt",
		"skill",
	]) {
		const value = input[key];
		if (typeof value === "string" && value) return value.split("\n")[0] ?? "";
	}
	return "";
}

const base = (path: unknown) =>
	typeof path === "string" ? (path.split("/").pop() ?? path) : "";

/**
 * What a tool call is doing, in words: Claude writes a description for every
 * command and agent, the rest read off the file or pattern. The raw input
 * stays one click under it.
 */
export function toolDescription(tool: {
	name: string;
	input: Record<string, unknown>;
}): string {
	const { name, input } = tool;
	if (typeof input.description === "string" && input.description)
		return input.description;
	switch (name) {
		case "Read":
			return `Read ${base(input.file_path)}`;
		case "Edit":
		case "MultiEdit":
			return `Edited ${base(input.file_path)}`;
		case "Write":
			return `Wrote ${base(input.file_path)}`;
		case "Grep":
		case "Glob":
			return `Searched for ${input.pattern}`;
		case "Skill":
			return `Used the ${input.skill} skill`;
		case "WebFetch":
			return `Opened ${input.url}`;
		case "WebSearch":
			return `Searched the web for ${input.query}`;
	}
	if (name === "Bash" && typeof input.command === "string")
		return commandDescription(input.command);
	return `${name} ${toolSummary(input)}`.trim();
}

const GIT: Record<string, string> = {
	log: "checked the git history",
	diff: "looked at the changes",
	show: "looked at a commit",
	status: "checked git status",
	fetch: "fetched from the remote",
	pull: "pulled from the remote",
	push: "pushed the branch",
	commit: "committed",
	add: "staged changes",
	checkout: "switched branch",
	switch: "switched branch",
	branch: "checked the branches",
	worktree: "set up a worktree",
	rebase: "rebased",
	merge: "merged",
	clone: "cloned a repo",
	grep: "searched the code",
};

const GH_PR: Record<string, string> = {
	list: "listed pull requests",
	view: "looked at a pull request",
	diff: "looked at a pull request's changes",
	create: "opened a pull request",
	merge: "merged a pull request",
	checks: "checked CI",
	comment: "commented on a pull request",
	edit: "edited a pull request",
};

/** Commands that only move around or print: nothing to say about them. */
const QUIET = new Set(["cd", "echo", "printf", "true", ":", "export"]);

const SEARCH = new Set(["grep", "rg", "ugrep", "ag", "find", "fd"]);
const READ = new Set(["cat", "head", "tail", "less", "bat", "wc", "nl"]);
const PACKAGE = new Set(["bun", "npm", "pnpm", "yarn", "uv"]);
const SCRIPT = new Set(["python", "python3", "node", "bash", "sh"]);

const flag = (arg: string) => arg.startsWith("-");

/** The file a read names: its last argument that looks like a path. */
const fileArg = (args: string[]) =>
	base([...args].reverse().find((arg) => /[./]/.test(arg) && !flag(arg)));

/** One command, before any pipe, in words; undefined when it says nothing. */
function phrase(words: string[]): string | undefined {
	while (words.length && /^\w+=/.test(words[0] ?? "")) words.shift();
	const [program = "", ...args] = words;
	const tool = base(program);
	const rest = args.filter((arg) => !flag(arg));
	if (!tool || QUIET.has(tool)) return undefined;
	if (tool === "git")
		return GIT[rest[0] ?? ""] ?? `ran git ${rest[0] ?? ""}`.trim();
	if (tool === "gh") {
		if (rest[0] === "pr")
			return GH_PR[rest[1] ?? ""] ?? "looked at pull requests";
		if (rest[0] === "run") return "checked CI runs";
		if (rest[0] === "issue") return "looked at issues";
		if (rest[0] === "api") return "called the GitHub API";
		return `ran gh ${rest[0] ?? ""}`.trim();
	}
	if (SEARCH.has(tool)) return "searched the files";
	if (READ.has(tool) || tool === "sed" || tool === "awk") {
		const file = fileArg(args);
		const edits = tool === "sed" && args.some((arg) => /^-i/.test(arg));
		return file && `${edits ? "edited" : "read"} ${file}`;
	}
	if (PACKAGE.has(tool)) {
		if (rest[0] === "test" || rest.includes("pytest")) return "ran the tests";
		if (["install", "i", "add", "sync"].includes(rest[0] ?? ""))
			return "installed dependencies";
		const what = rest[0] === "run" ? rest[1] : rest[0];
		return `ran ${what ? base(what) : tool}`;
	}
	if (SCRIPT.has(tool)) {
		const script = rest[0];
		return script && /[./]/.test(script) && !/\s/.test(script)
			? `ran ${base(script)}`
			: "ran a script";
	}
	switch (tool) {
		case "ls":
		case "tree":
			return "listed files";
		case "mkdir":
			return "made a folder";
		case "rm":
			return "deleted files";
		case "mv":
			return "moved files";
		case "cp":
			return "copied files";
		case "curl":
		case "wget":
			return "made a web request";
		case "sleep":
			return "waited";
		case "tsc":
			return "type-checked the code";
		case "biome":
		case "eslint":
		case "prettier":
			return "checked the code style";
		case "pytest":
		case "vitest":
		case "jest":
			return "ran the tests";
		case "npx":
		case "bunx":
			return rest[0] ? `ran ${base(rest[0])}` : undefined;
	}
	return `ran ${tool}`;
}

/**
 * A command Claude gave no description, in words: what each part of it
 * does ("Checked the git history and listed pull requests"), not the
 * command itself. What it pipes into (grep, head, jq) only trims the output.
 */
export function commandDescription(command: string): string {
	const said: string[] = [];
	for (const part of command.split(/&&|\|\||;|\n/)) {
		const head = part.split(/(?<!\|)\|(?!\|)/)[0] ?? "";
		const words = (head.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) =>
			word.replace(/^["']|["']$/g, ""),
		);
		const text = phrase(words);
		if (text && !said.includes(text)) said.push(text);
	}
	if (!said.length) return "Ran a command";
	const shown = said.slice(0, 2).join(" and ");
	const more = said.length > 2 ? `, +${said.length - 2} more` : "";
	return `${shown.charAt(0).toUpperCase()}${shown.slice(1)}${more}`;
}

/** "840", "2.1k", "12k". */
export function tokenLabel(n: number): string {
	if (n < 1000) return String(n);
	return n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

export function elapsedLabel(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	const pad = (n: number) => String(n).padStart(2, "0");
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
	return `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`;
}
