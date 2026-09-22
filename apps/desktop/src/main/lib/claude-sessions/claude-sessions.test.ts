import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseTranscript,
	queryTerms,
	readTranscript,
	repoNameOf,
	searchSessions,
	summarizeTranscript,
	transcriptOf,
	workingRepoOf,
} from "./claude-sessions";

const CWD = "/Users/dan/dev/private/odin";

/** A prompt you actually typed. */
function user(text: string) {
	return JSON.stringify({
		type: "user",
		cwd: CWD,
		timestamp: "2026-08-10T11:51:56.283Z",
		promptSource: "typed",
		message: { role: "user", content: text },
	});
}

/** An opening prompt as Odin's launcher writes it — the only kind listed. */
function task(text: string) {
	return user(`Task: ${text}\n\n${text}\n\nWork in the current workspace.`);
}

/**
 * Context Claude Code files as a "user" turn but you never typed: a skill body,
 * CLAUDE.md, hook output, an image placeholder. Byte-identical across sessions.
 */
function injected(text: string, extra: Record<string, unknown> = {}) {
	return JSON.stringify({
		type: "user",
		cwd: CWD,
		isMeta: true,
		sourceToolUseID: "toolu_x",
		message: { role: "user", content: [{ type: "text", text }] },
		...extra,
	});
}

function assistant(text: string) {
	return JSON.stringify({
		type: "assistant",
		cwd: CWD,
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
}

/** The boilerplate that made every session look like a Datadog session. */
const SKILL_BODY =
	"# Datadog Investigation Agent\n- API projects may have different logging patterns or no Datadog logs at all";

/** A store with two sessions: one about hotkeys, one about Datadog spend. */
function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "claude-sessions-"));
	const project = join(root, "-Users-dan-dev-private-odin");
	mkdirSync(
		join(project, "aaaa1111-2222-3333-4444-555566667777", "subagents"),
		{ recursive: true },
	);
	writeFileSync(
		join(project, "aaaa1111-2222-3333-4444-555566667777.jsonl"),
		[
			JSON.stringify({ type: "mode", mode: "normal" }),
			task("rebind the board hotkey"),
			injected(SKILL_BODY),
			assistant("Rebound it to the letter h in the registry."),
			JSON.stringify({ type: "ai-title", aiTitle: "Rebind the board hotkey" }),
			"{ not json at all",
		].join("\n"),
	);
	// Subagent transcripts are side-conversations, not resumable sessions.
	writeFileSync(
		join(
			project,
			"aaaa1111-2222-3333-4444-555566667777",
			"subagents",
			"agent-x.jsonl",
		),
		user("hotkey hotkey hotkey"),
	);
	writeFileSync(
		join(project, "bbbb1111-2222-3333-4444-555566667777.jsonl"),
		[
			task("investigate datadog and see which logs repeat the most"),
			injected(SKILL_BODY),
			assistant("Datadog logs are ~$4.3k/mo; here is how we reduce that cost."),
			JSON.stringify({
				type: "ai-title",
				aiTitle: "Investigate and reduce repeating Datadog logs",
			}),
		].join("\n"),
	);
	return root;
}

describe("queryTerms", () => {
	test("splits into keywords, drops noise, dedupes, caps", () => {
		expect(queryTerms("Optimizing Datadog COSTS")).toEqual([
			"optimizing",
			"datadog",
			"costs",
		]);
		expect(queryTerms("a datadog, datadog!")).toEqual(["datadog"]);
		expect(queryTerms("")).toEqual([]);
	});
});

describe("summarizeTranscript", () => {
	test("prefers Claude's own title, keeps the prompt, strips task scaffolding", () => {
		const summary = summarizeTranscript(
			[
				user(
					"Task: rebind the board hotkey\n\nWork in the current workspace. Go.",
				),
				assistant("done"),
				JSON.stringify({
					type: "ai-title",
					aiTitle: "Rebind the board hotkey",
				}),
			].join("\n"),
		);
		expect(summary.aiTitle).toBe("Rebind the board hotkey");
		expect(summary.prompt).toBe("rebind the board hotkey");
		expect(summary.cwd).toBe(CWD);
		expect(summary.messages).toBe(2);
	});

	test("drops the launcher's attachment list from the prompt", () => {
		const summary = summarizeTranscript(
			user(
				[
					"Task: use icons for the task category",
					"",
					"Attached files — read them before starting:",
					"/Users/dan/dev/private/odin/.odin/attachments/shot.png",
					"",
					"Work in the current workspace. Investigate.",
				].join("\n"),
			),
		);
		expect(summary.prompt).toBe("use icons for the task category");
	});

	test("de-stutters the Task-header form Odin's own launcher writes", () => {
		const summary = summarizeTranscript(
			user(
				[
					"Task: very hard to find an old session",
					"",
					"very hard to find an old session",
					"I want to search for keywords.",
					"",
					"Work in the current workspace. Investigate.",
				].join("\n"),
			),
		);
		expect(summary.prompt).toBe(
			"very hard to find an old session\nI want to search for keywords.",
		);
	});

	test("de-stutters even when the launcher elided the Task line", () => {
		const summary = summarizeTranscript(
			user(
				[
					"Task: I want a side panel that explains thi…",
					"",
					"I want a side panel that explains this session.",
					"",
					"Work in the current workspace. Investigate.",
				].join("\n"),
			),
		);
		expect(summary.prompt).toBe(
			"I want a side panel that explains this session.",
		);
	});

	test("a Slack session's prompt is the ask, not Odin's ingest recipe", () => {
		const summary = summarizeTranscript(
			user(
				[
					"Task: Hi good morning :sunny:",
					"",
					"This task comes from a Slack thread: https://imagenai.slack.com/archives/C0B/p1789357218234749",
					"",
					"What was posted there:",
					"Hi good morning :sunny:",
					"Can we stop charging RE users twice for an export?",
					"",
					"PHASE 1 — INGEST (do this first, before anything else):",
					"- Read the ENTIRE thread with your Slack tools.",
					"",
					"PHASE 2 — EXECUTE:",
					"- Work from .odin/brief-hi-good-m.md as your instructions.",
					"",
					"Work in the current workspace. Investigate.",
				].join("\n"),
			),
		);
		expect(summary.prompt).toBe(
			[
				"Hi good morning :sunny:",
				"",
				"This task comes from a Slack thread: https://imagenai.slack.com/archives/C0B/p1789357218234749",
				"",
				"What was posted there:",
				"Hi good morning :sunny:",
				"Can we stop charging RE users twice for an export?",
			].join("\n"),
		);
	});

	test("injected context is neither prose, prompt, nor searchable", () => {
		const jsonl = [injected(SKILL_BODY), user("the real question")].join("\n");
		const summary = summarizeTranscript(jsonl, ["datadog"]);
		expect(summary.prompt).toBe("the real question");
		expect(summary.messages).toBe(1);
		// The skill body says "Datadog" — but you never said it, so it's not a hit.
		expect(summary.bodyTerms.size).toBe(0);
		expect(summary.matches).toBe(0);
	});

	test("entries with no promptSource fall back to shape heuristics", () => {
		const bare = (text: string) =>
			JSON.stringify({
				type: "user",
				message: { role: "user", content: text },
			});
		const summary = summarizeTranscript(
			[
				bare("<command-name>/clear</command-name>"),
				bare("[Request interrupted by user]"),
				bare("a genuine follow-up"),
			].join("\n"),
		);
		expect(summary.prompt).toBe("a genuine follow-up");
		expect(summary.messages).toBe(1);
	});

	test("counts occurrences per term and reports which terms landed", () => {
		const summary = summarizeTranscript(
			[user("hotkey please"), assistant("hotkey done, hotkey twice")].join(
				"\n",
			),
			["hotkey", "missing"],
		);
		expect(summary.matches).toBe(3);
		expect([...summary.bodyTerms]).toEqual(["hotkey"]);
	});

	test("snippets prefer passages covering the most terms, yours first", () => {
		const summary = summarizeTranscript(
			[
				user("just datadog here"),
				assistant("datadog and cost together"),
				user("datadog and cost together"),
			].join("\n"),
			["datadog", "cost"],
		);
		expect(summary.snippets[0]).toEqual({
			role: "user",
			text: "datadog and cost together",
		});
		expect(summary.snippets[2]?.text).toBe("just datadog here");
	});
});

describe("searchSessions", () => {
	test("browsing lists every top-level session, newest first, never subagents", async () => {
		const root = fixtureRoot();
		const { sessions, total, terms } = await searchSessions({ root });
		expect(total).toBe(2);
		expect(terms).toEqual([]);
		expect(sessions.map((s) => s.title).sort()).toEqual([
			"Investigate and reduce repeating Datadog logs",
			"Rebind the board hotkey",
		]);
	});

	test("shared boilerplate no longer makes every session a hit", async () => {
		const root = fixtureRoot();
		const { sessions } = await searchSessions({ root, query: "datadog" });
		// Both files contain the skill body; only one is really about Datadog.
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.title).toBe(
			"Investigate and reduce repeating Datadog logs",
		);
	});

	test("finds a session by remembered gist, not its exact wording", async () => {
		const root = fixtureRoot();
		// Nobody wrote the phrase "optimizing datadog costs" in that session.
		const { sessions } = await searchSessions({
			root,
			query: "optimizing datadog costs",
		});
		expect(sessions[0]?.title).toBe(
			"Investigate and reduce repeating Datadog logs",
		);
	});

	test("ranks a session titled for the query above a passing mention", async () => {
		const root = fixtureRoot();
		const project = join(root, "-Users-dan-dev-private-odin");
		writeFileSync(
			join(project, "cccc1111-2222-3333-4444-555566667777.jsonl"),
			[
				task("unrelated work"),
				// Newest file, and says "datadog" more often — but only in passing.
				assistant(`datadog datadog datadog ${"datadog ".repeat(20)}`),
				JSON.stringify({ type: "ai-title", aiTitle: "Something else" }),
			].join("\n"),
		);
		const { sessions } = await searchSessions({ root, query: "datadog logs" });
		expect(sessions[0]?.title).toBe(
			"Investigate and reduce repeating Datadog logs",
		);
	});

	test("skips programmatic sessions you never typed in", async () => {
		const root = fixtureRoot();
		const project = join(root, "-Users-dan-dev-private-odin");
		// An SDK run (vibe-kanban and friends): its "user" turn was sent by a
		// program, and it never got a title — it lists as "session dddd1111".
		writeFileSync(
			join(project, "dddd1111-2222-3333-4444-555566667777.jsonl"),
			[
				JSON.stringify({
					type: "user",
					cwd: "/Users/dan/.cache/pip-tmp",
					promptSource: "sdk",
					message: { role: "user", content: "run the thing" },
				}),
				assistant("Ran the thing."),
				injected(SKILL_BODY),
			].join("\n"),
		);
		const { sessions } = await searchSessions({ root });
		expect(sessions.map((s) => s.title).sort()).toEqual([
			"Investigate and reduce repeating Datadog logs",
			"Rebind the board hotkey",
		]);
	});

	test("hides sessions that were not launched from Odin", async () => {
		const root = fixtureRoot();
		const project = join(root, "-Users-dan-dev-private-odin");
		// Typed straight into a terminal, no task prompt behind it.
		writeFileSync(
			join(project, "eeee1111-2222-3333-4444-555566667777.jsonl"),
			[
				user("NERDtree invalid path/"),
				assistant("Looks like a stray paste from vim."),
				JSON.stringify({
					type: "ai-title",
					aiTitle: "Fix NERDtree invalid path error",
				}),
			].join("\n"),
		);
		const { sessions } = await searchSessions({ root });
		expect(sessions.map((s) => s.title)).not.toContain(
			"Fix NERDtree invalid path error",
		);
		expect(sessions).toHaveLength(2);
	});

	test("finds a session by who asked, though the name is nowhere in it", async () => {
		const root = fixtureRoot();
		// Ofek's Slack message became the hotkey session. His name is in no
		// transcript, only in what Odin recorded when it launched the session.
		const people = new Map([
			[
				"aaaa1111-2222-3333-4444-555566667777",
				{ person: "Ofek Azulay", source: "reactions" },
			],
		]);
		const { sessions, askers } = await searchSessions({
			root,
			query: "ofek",
			people,
		});
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.title).toBe("Rebind the board hotkey");
		expect(sessions[0]?.person).toBe("Ofek Azulay");
		expect(askers).toEqual(["Ofek Azulay"]);
	});

	test("the feed a session came from is searchable by the word you'd type", async () => {
		const root = fixtureRoot();
		// The queue is called "reactions" internally; you'd search for "slack".
		const { sessions } = await searchSessions({
			root,
			query: "slack",
			people: new Map([
				[
					"aaaa1111-2222-3333-4444-555566667777",
					{ person: "Ofek Azulay", source: "reactions" },
				],
			]),
		});
		expect(sessions.map((session) => session.title)).toEqual([
			"Rebind the board hotkey",
		]);
	});

	test("clicking a person beats a session that merely talks about them", async () => {
		const root = fixtureRoot();
		const project = join(root, "-Users-dan-dev-private-odin");
		writeFileSync(
			join(project, "ffff1111-2222-3333-4444-555566667777.jsonl"),
			[
				task("ofek ofek ofek ofek ofek"),
				JSON.stringify({ type: "ai-title", aiTitle: "Talking about Ofek" }),
			].join("\n"),
		);
		// What the chip puts in the box: the whole name.
		const { sessions } = await searchSessions({
			root,
			query: "Ofek Azulay",
			people: new Map([
				[
					"aaaa1111-2222-3333-4444-555566667777",
					{ person: "Ofek Azulay", source: "reactions" },
				],
			]),
		});
		expect(sessions[0]?.title).toBe("Rebind the board hotkey");
	});

	test("askers drops anyone whose session is no longer on disk", async () => {
		const root = fixtureRoot();
		const { askers } = await searchSessions({
			root,
			people: new Map([
				[
					"gone-0000-0000-0000-000000000000",
					{ person: "Nobody", source: "jira" },
				],
			]),
		});
		expect(askers).toEqual([]);
	});

	test("respects limit", async () => {
		const root = fixtureRoot();
		const { sessions } = await searchSessions({ root, limit: 1 });
		expect(sessions).toHaveLength(1);
	});
});

describe("parseTranscript / readTranscript", () => {
	test("returns prose turns only, skipping injected context and sidechains", () => {
		const messages = parseTranscript(
			[
				user("hello"),
				injected(SKILL_BODY),
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
				}),
				JSON.stringify({
					type: "assistant",
					isSidechain: true,
					message: { content: [{ type: "text", text: "subagent chatter" }] },
				}),
				assistant("hi back"),
			].join("\n"),
		);
		expect(messages).toEqual([
			{ role: "user", text: "hello", at: "2026-08-10T11:51:56.283Z" },
			{ role: "assistant", text: "hi back", at: null },
		]);
	});

	test("finds a session by id alone — a pane knows the id, not the directory", async () => {
		const transcript = await readTranscript({
			sessionId: "aaaa1111-2222-3333-4444-555566667777",
			root: fixtureRoot(),
		});
		expect(transcript.title).toBe("Rebind the board hotkey");
		expect(transcript.prompt).toBe("rebind the board hotkey");
		expect(transcript.cwd).toBe(CWD);
	});

	test("says so when no project holds that session", async () => {
		await expect(
			readTranscript({ sessionId: "nope", root: fixtureRoot() }),
		).rejects.toThrow("No transcript on this machine");
	});

	test("refuses a traversal-shaped reference", async () => {
		await expect(
			readTranscript({
				project: "../../etc",
				sessionId: "passwd",
				root: fixtureRoot(),
			}),
		).rejects.toThrow("Invalid transcript reference");
	});
});

describe("repoNameOf", () => {
	function tree() {
		return mkdtempSync(join(tmpdir(), "odin-repo-name-"));
	}

	test("names a clone after its own directory", () => {
		const root = tree();
		mkdirSync(join(root, "app-web-server", ".git"), { recursive: true });
		expect(repoNameOf(join(root, "app-web-server"))).toBe("app-web-server");
	});

	test("names a worktree after the repo that owns it, not its branch", () => {
		const root = tree();
		const worktree = join(root, ".worktrees", "review-6460");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(
			join(worktree, ".git"),
			`gitdir: ${root}/app-web-server/.git/worktrees/review-6460\n`,
		);
		expect(repoNameOf(worktree)).toBe("app-web-server");
	});

	test("falls back to the directory name for a submodule", () => {
		const root = tree();
		const submodule = join(root, "vendored");
		mkdirSync(submodule, { recursive: true });
		writeFileSync(
			join(submodule, ".git"),
			`gitdir: ${root}/.git/modules/vendored\n`,
		);
		expect(repoNameOf(submodule)).toBe("vendored");
	});

	test("falls back to the directory name when there is no .git at all", () => {
		const root = tree();
		mkdirSync(join(root, "loose"), { recursive: true });
		expect(repoNameOf(join(root, "loose"))).toBe("loose");
	});
});

describe("workingRepoOf", () => {
	const SESSION = "bbbb1111-2222-3333-4444-555566667777";

	/** Lay out real checkouts — the resolver walks the filesystem for `.git`. */
	function repos(root: string, layout: Record<string, "clone" | "worktree">) {
		for (const [rel, kind] of Object.entries(layout)) {
			const dir = join(root, rel);
			mkdirSync(dir, { recursive: true });
			// A worktree's `.git` is a file pointing at the real gitdir.
			if (kind === "clone") mkdirSync(join(dir, ".git"), { recursive: true });
			else writeFileSync(join(dir, ".git"), "gitdir: /elsewhere\n");
		}
	}

	function transcript(root: string, cwds: string[]) {
		const project = join(root, "-Users-dan-dev");
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(project, `${SESSION}.jsonl`),
			[
				...cwds.map((cwd) => JSON.stringify({ type: "assistant", cwd })),
				"{ truncated mid-write",
			].join("\n"),
		);
	}

	function dirs() {
		return {
			root: mkdtempSync(join(tmpdir(), "claude-repo-")),
			tree: mkdtempSync(join(tmpdir(), "checkouts-")),
		};
	}

	/**
	 * The bug this replaced: every transcript entry carries the cwd of that one
	 * tool call, so "the last cwd" is wherever the agent last ran a command. A
	 * session whose work was in one repo reported another entirely after a single
	 * unrelated lookup, and the diff panel silently rendered that other repo.
	 */
	test("is the repo the session worked in, not the one it last looked at", async () => {
		const { root, tree } = dirs();
		repos(tree, { work: "clone", detour: "clone" });
		transcript(root, [
			join(tree, "work"),
			join(tree, "work/src"),
			join(tree, "work/src/deep"),
			join(tree, "detour"),
		]);

		expect(await workingRepoOf(SESSION, root)).toBe(join(tree, "work"));
	});

	/** A worktree is its own checkout: the main clone holds unrelated work. */
	test("treats a worktree as its own repo", async () => {
		const { root, tree } = dirs();
		repos(tree, { main: "clone", "main/.worktrees/feature": "worktree" });
		transcript(root, [
			join(tree, "main"),
			join(tree, "main/.worktrees/feature"),
			join(tree, "main/.worktrees/feature/src"),
		]);

		expect(await workingRepoOf(SESSION, root)).toBe(
			join(tree, "main/.worktrees/feature"),
		);
	});

	test("breaks a tie on the most recent, so the answer is stable", async () => {
		const { root, tree } = dirs();
		repos(tree, { first: "clone", second: "clone" });
		transcript(root, [join(tree, "first"), join(tree, "second")]);

		expect(await workingRepoOf(SESSION, root)).toBe(join(tree, "second"));
	});

	test("ignores directories outside any repo, however often they appear", async () => {
		const { root, tree } = dirs();
		repos(tree, { work: "clone" });
		mkdirSync(join(tree, "loose"), { recursive: true });
		transcript(root, [
			join(tree, "loose"),
			join(tree, "loose"),
			join(tree, "loose"),
			join(tree, "work"),
		]);

		expect(await workingRepoOf(SESSION, root)).toBe(join(tree, "work"));
	});

	test("is null for an unknown session, and for a repo-less transcript", async () => {
		const { root, tree } = dirs();
		mkdirSync(join(tree, "loose"), { recursive: true });
		transcript(root, [join(tree, "loose")]);

		expect(await workingRepoOf("no-such-session", root)).toBeNull();
		expect(await workingRepoOf(SESSION, root)).toBeNull();
	});

	test("prefers a nested repo over the container that holds it", () => {
		const tree = mkdtempSync(join(tmpdir(), "odin-container-"));
		const root = mkdtempSync(join(tmpdir(), "odin-projects-"));
		// `~/dev` is a repo of its own AND the directory every clone sits in, so
		// tool calls that never cd anywhere pile votes onto it. The work is in
		// the checkout it contains.
		repos(tree, { dev: "clone", "dev/imagen/app": "clone" });
		transcript(root, [
			...Array(9).fill(join(tree, "dev/imagen")),
			...Array(4).fill(join(tree, "dev/imagen/app")),
		]);
		return expect(workingRepoOf(SESSION, root)).resolves.toBe(
			join(tree, "dev/imagen/app"),
		);
	});

	test("counts a worktree as its repo, not as a rival to it", () => {
		const tree = mkdtempSync(join(tmpdir(), "odin-worktree-vote-"));
		const root = mkdtempSync(join(tmpdir(), "odin-projects-"));
		// A catch-all directory the agent keeps returning to, and a repo whose
		// work is split between its clone and a worktree of it. Neither half of
		// the split outvotes the catch-all; together they do.
		repos(tree, { dev: "clone", "dev/app": "clone" });
		const worktree = join(tree, "dev/trees/fix");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(
			join(worktree, ".git"),
			`gitdir: ${join(tree, "dev/app")}/.git/worktrees/fix\n`,
		);
		transcript(root, [
			...Array(5).fill(join(tree, "dev")),
			...Array(3).fill(join(tree, "dev/app")),
			...Array(4).fill(worktree),
		]);
		return expect(workingRepoOf(SESSION, root)).resolves.toBe(worktree);
	});
});

/**
 * The check behind Resume. A pane pins its conversation id at launch
 * (`--session-id`), but that is not proof Claude ever wrote the transcript —
 * one board session ran a full turn and left none, so Resume ran
 * `claude --resume <id>`, got "No conversation found with session ID" and
 * exited into a dead pane. Resume reads the transcript by id first and starts
 * a fresh session when there is none, so the message it rejects with is load
 * bearing, not cosmetic.
 */
describe("reading a session by id alone", () => {
	test("rejects an id Claude never wrote, by the message Resume matches", () => {
		const root = fixtureRoot();
		return expect(
			readTranscript({
				sessionId: "29c5f5da-1c1e-40b8-8914-4a9b89830be2",
				root,
			}),
		).rejects.toThrow("No transcript on this machine");
	});

	test("reads a session Claude did write", async () => {
		const root = fixtureRoot();
		const read = await readTranscript({
			sessionId: "bbbb1111-2222-3333-4444-555566667777",
			root,
		});
		expect(read.title).toBe("Investigate and reduce repeating Datadog logs");
	});
});

describe("transcriptOf", () => {
	test("finds a session by id alone, across projects", async () => {
		const root = fixtureRoot();
		const found = await transcriptOf(
			"bbbb1111-2222-3333-4444-555566667777",
			root,
		);
		expect(found?.path).toContain("bbbb1111-2222-3333-4444-555566667777.jsonl");
	});

	test("an id Claude never wrote is null, not a guess", async () => {
		const root = fixtureRoot();
		expect(
			await transcriptOf("29c5f5da-1c1e-40b8-8914-4a9b89830be2", root),
		).toBeNull();
	});

	test("a subagent side-conversation is not a resumable session", async () => {
		const root = fixtureRoot();
		expect(await transcriptOf("agent-x", root)).toBeNull();
	});

	test("a path pretending to be an id gets no filesystem walk", async () => {
		const root = fixtureRoot();
		expect(await transcriptOf("../../../etc/passwd", root)).toBeNull();
	});
});
