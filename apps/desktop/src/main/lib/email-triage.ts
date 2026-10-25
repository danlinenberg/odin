import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	type IgnoredEmail,
	readOdinConfig,
	updateOdinConfig,
} from "lib/trpc/routers/odin-config";
import { execWithShellEnv } from "lib/trpc/routers/workspaces/utils/shell-env";
import { isCalendarMail } from "shared/calendar-mail";
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

const INSTRUCTIONS = `You triage my unread email. Say which ones are worth my attention.
Interesting: a person writing to me or asking something of me, anything I'd want to read or answer.
Junk: automated mail - alerts, notifications, receipts, product updates, newsletters, marketing, event platforms (registrations, RSVPs, reminders), "your X is ready", a service telling me what someone did ("X has joined", "X registered", "X shared", "X invited you"), and sales or vendor outreach (a rep pitching, chasing a renewal, an upgrade or "usage alignment"), even when a person signs it.
Each line is: number | sender name <address> | subject | preview.
Answer with ONLY a JSON object, no prose: {"interesting": [line numbers]}.`;

/** How many "Ignore mail like this" examples are kept - the newest win. */
const MAX_IGNORED = 40;

const sameSender = (a: string | null, b: string | null) =>
	!!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The prompt: my rules, then the mail I told Odin to ignore, as examples. */
export function triagePrompt(ignored: IgnoredEmail[]): string {
	if (ignored.length === 0) return INSTRUCTIONS;
	const examples = ignored.map(
		(email) =>
			`- ${email.from ?? "-"} <${email.fromEmail ?? "-"}> | ${email.subject}`,
	);
	return `${INSTRUCTIONS}\nI told you to ignore mail like these - treat mail like them as junk too:\n${examples.join("\n")}`;
}

/** Senders I ignored are junk outright; the rest is the model's call. */
export function ignoredSender(
	email: TriageEmail,
	ignored: IgnoredEmail[],
): boolean {
	return ignored.some((rule) => sameSender(rule.fromEmail, email.fromEmail));
}

/** "Ignore mail like this": remember it, and re-ask about everything. */
export function ignoreEmail(email: IgnoredEmail): void {
	const ignored = (readOdinConfig().ignoredEmails ?? []).filter(
		(old) =>
			!(
				sameSender(old.fromEmail, email.fromEmail) &&
				old.subject === email.subject
			),
	);
	updateOdinConfig({ ignoredEmails: [...ignored, email].slice(-MAX_IGNORED) });
	verdicts.clear();
}

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

const verdicts = new Map<string, boolean>();
let inFlight: Promise<void> | null = null;

/** Email id → junk? Missing ids are ones the model couldn't judge - show them. */
export async function triageEmails(
	emails: TriageEmail[],
	{ timeoutMs = 90_000 }: { timeoutMs?: number } = {},
): Promise<Map<string, boolean>> {
	const ignored = readOdinConfig().ignoredEmails ?? [];
	for (const email of emails)
		if (isCalendarMail(email.subject) || ignoredSender(email, ignored))
			verdicts.set(email.id, true);
	// One model call at a time: the next poll waits for it rather than
	// asking the same question twice.
	if (inFlight) await inFlight.catch(() => {});
	const fresh = emails.filter((email) => !verdicts.has(email.id));
	if (fresh.length > 0) {
		inFlight = ask(fresh, triagePrompt(ignored), timeoutMs);
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

async function ask(
	emails: TriageEmail[],
	prompt: string,
	timeoutMs: number,
): Promise<void> {
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
				`${prompt}\n\n--- EMAILS ---\n${lines.join("\n")}`,
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
