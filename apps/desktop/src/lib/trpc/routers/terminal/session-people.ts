import { workLog } from "@odin/local-db";
import { desc } from "drizzle-orm";
import { appState } from "main/lib/app-state";
import type { SessionPerson } from "main/lib/claude-sessions";
import { localDb } from "main/lib/local-db";

/**
 * Who asked for each session, so Session History can be searched by person.
 *
 * A reporter's name is never in the transcript — the prompt is the ticket, not
 * the person — so it has to be joined in from what Odin recorded at launch.
 * Two records hold it, and both are needed: `work_log` is the durable ledger
 * but only exists for launches since it landed, while the board's panes have
 * carried `odinContact` for far longer. The ledger wins where they overlap:
 * it's the one that outlives the pane.
 *
 * ponytail: rebuilt per search (a few hundred rows, no I/O beyond a SELECT).
 * Cache it on work_log's newest startedAt if the scan ever shows up.
 */
export function sessionPeople(): Map<string, SessionPerson> {
	const people = new Map<string, SessionPerson>();
	for (const row of Object.values(appState.data.tabsState.panes ?? {})) {
		if (row.claudeSessionId && row.odinContact) {
			people.set(row.claudeSessionId, {
				person: row.odinContact,
				source: row.odinSource ?? null,
			});
		}
	}
	// The ledger only sharpens what the panes already say, so a store that
	// can't answer (a build predating its migration) must not take the whole of
	// Session History down with it.
	let logged: {
		sessionId: string | null;
		person: string | null;
		source: string;
	}[] = [];
	try {
		logged = localDb
			.select()
			.from(workLog)
			.orderBy(desc(workLog.startedAt))
			.limit(500)
			.all();
	} catch (error) {
		console.warn("[session-people] work log unreadable:", error);
	}
	// Inserted oldest-first and reversed at the end, because the chips want the
	// people you dealt with most recently. A session in both records keeps its
	// place and takes the ledger's value — that's the one that outlives the pane.
	for (const row of [...logged].reverse()) {
		if (row.sessionId) {
			people.set(row.sessionId, { person: row.person, source: row.source });
		}
	}
	return new Map([...people].reverse());
}
