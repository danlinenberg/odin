import { describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PR_RULES_HEADER } from "shared/odin-rules";
import {
	activeLoop,
	lastCwd,
	parseTranscript,
	pendingPrompt,
	ranHere,
	readTranscript,
	ruleFirings,
	slackDrafts,
	summarizeTranscript,
	transcriptLinks,
} from "./claude-sessions";
import { transcriptCredential } from "./credential";
import { transcriptUsage } from "./usage";

const CWD = `${homedir()}/dev/app`;
const at = (minute: number) =>
	`2026-10-26T09:${String(minute).padStart(2, "0")}:00.000Z`;

/** A session that touches every reader readTranscript runs. */
function rows(): string[] {
	const out: string[] = [];
	const push = (row: object) => out.push(JSON.stringify(row));
	const typed = (text: string, minute: number) =>
		push({
			type: "user",
			cwd: CWD,
			timestamp: at(minute),
			message: { role: "user", content: text },
		});
	const said = (content: unknown[], minute: number, id = `m${minute}`) =>
		push({
			type: "assistant",
			cwd: CWD,
			timestamp: at(minute),
			message: {
				id,
				role: "assistant",
				model: "claude-opus-5-5",
				content,
				usage: { input_tokens: 10, output_tokens: 5 },
			},
		});
	const result = (id: string, text: string, minute: number) =>
		push({
			type: "user",
			cwd: CWD,
			timestamp: at(minute),
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: id, content: text }],
			},
		});
	typed("Task: fix the login page ü\n\nsee https://example.com/ticket/1", 0);
	push({ type: "ai-title", aiTitle: "Fix the login page" });
	push({
		type: "api-request",
		timestamp: at(1),
		params: { betas: ["oauth-2025-04-20"] },
	});
	said([{ type: "text", text: `Looking. ${"long ".repeat(2000)}` }], 1);
	said(
		[
			{
				type: "tool_use",
				id: "pr1",
				name: "Bash",
				input: { command: "gh pr create --fill" },
			},
		],
		2,
	);
	result("pr1", "https://github.com/acme/app/pull/7", 3);
	push({
		type: "attachment",
		attachment: {
			type: "hook_additional_context",
			toolUseID: "pr1",
			content: [`${PR_RULES_HEADER}\n- When you open a PR: run the checks`],
		},
	});
	said(
		[
			{
				type: "tool_use",
				id: "s1",
				name: "mcp__slack__slack_send_message_draft",
				input: { channel_id: "C0123", thread_ts: "1.2", message: "hi" },
			},
		],
		4,
	);
	said(
		[
			{
				type: "tool_use",
				id: "c1",
				name: "CronCreate",
				input: { cron: "*/5 * * * *", prompt: "check CI" },
			},
		],
		5,
	);
	push({ type: "user", cwd: "/elsewhere/gone", message: { content: "x" } });
	push({
		type: "api-request",
		timestamp: at(6),
		params: { betas: [] },
	});
	for (let i = 0; i < 30; i++) {
		typed(`question ${i} about https://example.com/doc/${i}`, 7);
		said([{ type: "text", text: `answer ${i} ✓` }], 8, `a${i}`);
	}
	said(
		[
			{
				type: "tool_use",
				id: "q1",
				name: "AskUserQuestion",
				input: { questions: [{ question: "Which one?" }] },
			},
		],
		9,
	);
	return out;
}

/** What a read of the whole file says, the way readTranscript used to read it. */
function fullRead(jsonl: string, path: string) {
	const { cwd, aiTitle, prompt } = summarizeTranscript(jsonl);
	return {
		path: realpathSync(path),
		messages: parseTranscript(jsonl, 500, 6000, false),
		links: transcriptLinks(jsonl),
		cwd,
		local: ranHere(cwd) || ranHere(lastCwd(jsonl)),
		title: aiTitle,
		prompt,
		loop: activeLoop(jsonl),
		rules: ruleFirings(jsonl),
		usage: transcriptUsage(jsonl),
		credential: transcriptCredential(jsonl),
		slackDrafts: slackDrafts(jsonl),
		openPrompt: pendingPrompt(jsonl) !== null,
	};
}

describe("readTranscript, read as the file grows", () => {
	const id = "abcd1111-2222-3333-4444-555566667777";
	const setup = () => {
		const root = mkdtempSync(join(tmpdir(), "claude-grow-"));
		mkdirSync(join(root, "-dev-app"));
		return { root, file: join(root, "-dev-app", `${id}.jsonl`) };
	};

	test("each read of an appended file matches a read of the whole file", async () => {
		const { root, file } = setup();
		const text = `${rows().join("\n")}\n`;
		const bytes = Buffer.from(text);
		// Chunks that end mid-line, mid-character (the ü and ✓) and on a newline.
		const cuts = [
			0,
			bytes.indexOf("ü") + 1,
			bytes.indexOf("\n", 400) + 1,
			Math.floor(bytes.length / 3),
			bytes.indexOf("✓") + 1,
			Math.floor((bytes.length * 2) / 3),
			bytes.length - 5,
			bytes.length,
		].sort((a, b) => a - b);
		writeFileSync(file, "");
		for (let i = 1; i < cuts.length; i++) {
			appendFileSync(file, bytes.subarray(cuts[i - 1], cuts[i]));
			const read = await readTranscript({ sessionId: id, root });
			// A whole file read stops at the same complete lines.
			const written = bytes.subarray(0, cuts[i]).toString("utf8");
			expect(read).toEqual(fullRead(written, file));
		}
		const done = await readTranscript({ sessionId: id, root });
		expect(done.openPrompt).toBe(true);
		expect(done.rules).toHaveLength(1);
		expect(done.links.length).toBeGreaterThan(30);
	});

	test("a last line written without its newline counts once it's whole", async () => {
		const { root, file } = setup();
		const all = rows();
		writeFileSync(file, all.slice(0, 5).join("\n"));
		expect(await readTranscript({ sessionId: id, root })).toEqual(
			fullRead(all.slice(0, 5).join("\n"), file),
		);
		appendFileSync(file, `\n${all.slice(5).join("\n")}\n`);
		expect(await readTranscript({ sessionId: id, root })).toEqual(
			fullRead(`${all.join("\n")}\n`, file),
		);
	});

	test("a file cut shorter or rewritten is read again from the start", async () => {
		const { root, file } = setup();
		const all = rows();
		writeFileSync(file, `${all.join("\n")}\n`);
		await readTranscript({ sessionId: id, root });

		const shorter = `${all.slice(0, 8).join("\n")}\n`;
		writeFileSync(file, shorter);
		expect(await readTranscript({ sessionId: id, root })).toEqual(
			fullRead(shorter, file),
		);

		// Longer than before, but not what was read: its opening rows changed.
		const other = `${all
			.slice(0, 8)
			.map((row) => row.replace("login", "LOGIN"))
			.join("\n")}\n${all.slice(8).join("\n")}\n`;
		writeFileSync(file, other);
		expect(await readTranscript({ sessionId: id, root })).toEqual(
			fullRead(other, file),
		);
	});

	test("an appended read is quicker than the first", async () => {
		const { root, file } = setup();
		const block = `${rows().join("\n")}\n`;
		writeFileSync(file, block.repeat(400));
		let start = performance.now();
		await readTranscript({ sessionId: id, root });
		const first = performance.now() - start;
		appendFileSync(file, block);
		start = performance.now();
		await readTranscript({ sessionId: id, root });
		expect(performance.now() - start).toBeLessThan(first);
	});
});
