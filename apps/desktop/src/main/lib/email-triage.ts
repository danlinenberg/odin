import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execWithShellEnv } from "lib/trpc/routers/workspaces/utils/shell-env";
import { transcriptOf } from "./claude-sessions/claude-sessions";

/**
 * Which unread emails are junk. A model reads sender, subject and preview -
 * no sender list to maintain. Same `claude -p` haiku path as Next in line.
 */

export interface TriageEmail {
	id: string;
	subject: string;
	snippet: string;
	from: string | null;
	fromEmail: string | null;
}

/** Invites, RSVPs and cancellations are never a row - the calendar has them. */
export const isCalendarMail = (subject: string) =>
	/^(updated |new event: |canceled event: |cancelled event: )?(invitation|accepted|declined|tentatively accepted|canceled|cancelled)( event)?:/i.test(
		subject.trim(),
	);

const INSTRUCTIONS = `You triage my unread email. Say which ones are worth my attention.
Interesting: a person writing to me or asking something of me, anything I'd want to read or answer.
Junk: automated mail - alerts, notifications, receipts, product updates, newsletters, marketing, event platforms, "your X is ready".
Each line is: number | sender name <address> | subject | preview.
Answer with ONLY a JSON object, no prose: {"interesting": [line numbers]}.`;

/** Line numbers → ids. Anything it didn't name is junk; unparseable → null. */
export function parseTriage(text: string, ids: string[]): Set<string> | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		const { interesting } = JSON.parse(text.slice(start, end + 1)) as {
			interesting?: unknown;
		};
		if (!Array.isArray(interesting)) return null;
		return new Set(
			interesting.flatMap((n) =>
				Number.isInteger(n) && ids[n - 1] ? [ids[n - 1]] : [],
			),
		);
	} catch {
		return null;
	}
}

// ponytail: in-memory verdict per email id - each email is asked about once,
// so a poll with nothing new costs nothing. A restart re-asks about ≤20.
const verdicts = new Map<string, boolean>();
let inFlight: Promise<void> | null = null;

/** Email id → junk? Missing ids are ones the model couldn't judge - show them. */
export async function triageEmails(
	emails: TriageEmail[],
	{ timeoutMs = 90_000 }: { timeoutMs?: number } = {},
): Promise<Map<string, boolean>> {
	for (const email of emails)
		if (isCalendarMail(email.subject)) verdicts.set(email.id, true);
	// One model call at a time: the next poll waits for it rather than
	// asking the same question twice.
	if (inFlight) await inFlight.catch(() => {});
	const fresh = emails.filter((email) => !verdicts.has(email.id));
	if (fresh.length > 0) {
		inFlight = ask(fresh, timeoutMs);
		try {
			await inFlight;
		} catch (error) {
			console.warn("[email-triage] model failed, showing everything:", error);
		} finally {
			inFlight = null;
		}
	}
	return new Map(
		emails.flatMap((email) => {
			const junk = verdicts.get(email.id);
			return junk === undefined ? [] : [[email.id, junk] as const];
		}),
	);
}

async function ask(emails: TriageEmail[], timeoutMs: number): Promise<void> {
	const ids = emails.map((email) => email.id);
	const lines = emails.map((email, index) =>
		[
			index + 1,
			`${email.from ?? "-"} <${email.fromEmail ?? "-"}>`,
			email.subject,
			email.snippet.slice(0, 200),
		]
			.join(" | ")
			.replace(/\s+/g, " "),
	);
	// Named so its transcript can be deleted, like the Next in line ranking.
	const sessionId = randomUUID();
	try {
		const { stdout } = await execWithShellEnv(
			"claude",
			[
				"-p",
				`${INSTRUCTIONS}\n\n--- EMAILS ---\n${lines.join("\n")}`,
				"--model",
				"haiku",
				"--session-id",
				sessionId,
				"--strict-mcp-config",
				"--mcp-config",
				'{"mcpServers":{}}',
			],
			{ cwd: tmpdir(), timeout: timeoutMs, maxBuffer: 1_000_000 },
		);
		const interesting = parseTriage(stdout, ids);
		if (!interesting)
			throw new Error(`unparseable answer: ${stdout.slice(0, 200)}`);
		if (verdicts.size > 500) verdicts.clear();
		for (const id of ids) verdicts.set(id, !interesting.has(id));
	} finally {
		const litter = await transcriptOf(sessionId);
		if (litter) await rm(litter.path, { force: true });
	}
}
