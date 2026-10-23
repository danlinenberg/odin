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
	return `${name} ${toolSummary(input)}`.trim();
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
