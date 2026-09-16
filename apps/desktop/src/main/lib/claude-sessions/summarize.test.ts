import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, parseBrief, warmBriefs, writeBrief } from "./summarize";

/**
 * A fresh session id per fixture. The queue, the in-flight map and the loaded
 * cache are module state, so two tests sharing an id share each other's state.
 */
let seq = 0;
const nextSession = () =>
	`aaaa1111-2222-3333-4444-${String(++seq).padStart(12, "0")}`;

/**
 * A store holding one session, plus a stand-in for the `claude` binary that
 * counts its runs — so the caching can be checked without a 15s model call.
 */
function fixture(session: string = nextSession()) {
	const root = mkdtempSync(join(tmpdir(), "summarize-"));
	const project = join(root, "-Users-dan-dev-private-odin");
	mkdirSync(project, { recursive: true });
	const transcript = join(project, `${session}.jsonl`);
	writeFileSync(
		transcript,
		[
			JSON.stringify({
				type: "user",
				promptSource: "typed",
				cwd: "/x",
				message: { role: "user", content: "make the coupons" },
			}),
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "did" }],
				},
			}),
		].join("\n"),
	);
	const runs = join(root, "runs");
	writeFileSync(runs, "");
	const bin = join(root, "fake-claude.sh");
	// Like the real thing, it files a transcript of its own run under
	// --session-id — the litter writeBrief has to clear up after itself.
	writeFileSync(
		bin,
		[
			"#!/bin/sh",
			`echo x >> ${runs}`,
			"while [ $# -gt 0 ]; do",
			`  [ "$1" = "--session-id" ] && echo '{}' > ${project}/"$2".jsonl`,
			"  shift",
			"done",
			'echo "TITLE: t"',
			'echo "GOAL: g"',
			'echo "STATUS: s"',
			'echo "NEXT: n"',
			"",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	return {
		session,
		root,
		bin,
		project,
		transcript,
		cachePath: join(root, "briefs.json"),
		runCount: () =>
			readFileSync(runs, "utf-8").trim().split("\n").filter(Boolean).length,
	};
}

describe("writeBrief", () => {
	test("runs the model once, then serves the cached brief", async () => {
		const { session, root, bin, cachePath, runCount } = fixture();
		const first = await writeBrief({
			sessionId: session,
			claudeBin: bin,
			root,
			cachePath,
		});
		expect(first).toMatchObject({ goal: "g", status: "s", next: "n" });
		expect(first.cached).toBe(false);

		const second = await writeBrief({
			sessionId: session,
			claudeBin: bin,
			root,
			cachePath,
		});
		expect(second.cached).toBe(true);
		expect(second.goal).toBe("g");
		expect(runCount()).toBe(1);
	});

	test("the brief survives a restart — it is read back off disk", async () => {
		const { session, root, bin, cachePath, runCount } = fixture();
		await writeBrief({ sessionId: session, claudeBin: bin, root, cachePath });
		expect(JSON.parse(readFileSync(cachePath, "utf-8"))[session].brief).toEqual(
			{
				title: "t",
				goal: "g",
				status: "s",
				next: "n",
				tags: [],
				raw: null,
			},
		);

		// A restart loses the in-memory map. Point the module at another cache and
		// back, which forces the reload from disk that a cold start does.
		const other = fixture();
		await writeBrief({
			sessionId: other.session,
			claudeBin: other.bin,
			root: other.root,
			cachePath: other.cachePath,
		});

		const afterRestart = await writeBrief({
			sessionId: session,
			claudeBin: bin,
			root,
			cachePath,
		});
		expect(afterRestart.cached).toBe(true);
		expect(afterRestart.goal).toBe("g");
		expect(runCount()).toBe(1);
	});

	test("rewrites the brief once the session says something new", async () => {
		const { session, root, bin, transcript, cachePath, runCount } = fixture();
		const t0 = Date.now();
		await writeBrief({
			sessionId: session,
			claudeBin: bin,
			root,
			cachePath,
			now: t0,
		});
		// The agent took another turn, and the brief has gone cold.
		const later = new Date(t0 + 60_000);
		utimesSync(transcript, later, later);
		const after = await writeBrief({
			sessionId: session,
			claudeBin: bin,
			root,
			cachePath,
			now: t0 + 6 * 60_000,
		});
		expect(after.cached).toBe(false);
		expect(runCount()).toBe(2);
	});

	test("only one model run is in flight per session", async () => {
		const { session, root, bin, cachePath, runCount } = fixture();
		const [a, b] = await Promise.all([
			writeBrief({ sessionId: session, claudeBin: bin, root, cachePath }),
			writeBrief({ sessionId: session, claudeBin: bin, root, cachePath }),
		]);
		expect(a.goal).toBe("g");
		expect(b.goal).toBe("g");
		expect(runCount()).toBe(1);
	});

	test("a cold brief is rewritten once the session moves on", async () => {
		const { session, root, bin, transcript, cachePath, runCount } = fixture();
		const t0 = Date.now();
		await writeBrief({
			sessionId: session,
			claudeBin: bin,
			root,
			cachePath,
			now: t0,
		});
		const later = new Date(t0 + 60_000);
		utimesSync(transcript, later, later);
		// Same transcript change, but the last brief is minutes old now.
		const after = await writeBrief({
			sessionId: session,
			claudeBin: bin,
			root,
			cachePath,
			now: t0 + 6 * 60_000,
		});
		expect(after.cached).toBe(false);
		expect(runCount()).toBe(2);
	});

	test("a busy session is not re-summarised on every write", async () => {
		const { session, root, bin, transcript, cachePath, runCount } = fixture();
		const t0 = Date.now();
		await writeBrief({
			sessionId: session,
			claudeBin: bin,
			root,
			cachePath,
			now: t0,
		});
		// The agent wrote another turn seconds later — too soon to pay for a rewrite.
		const later = new Date(t0 + 30_000);
		utimesSync(transcript, later, later);
		const again = await writeBrief({
			sessionId: session,
			claudeBin: bin,
			root,
			cachePath,
			now: t0 + 60_000,
		});
		expect(again.cached).toBe(true);
		expect(runCount()).toBe(1);
	});

	test("leaves no transcript of its own behind", async () => {
		const { session, root, bin, project, cachePath } = fixture();
		await writeBrief({ sessionId: session, claudeBin: bin, root, cachePath });
		// Only the session being summarised — the summarising run's own transcript
		// is gone, or Session History fills with sessions nobody started.
		expect(readdirSync(project)).toEqual([`${session}.jsonl`]);
	});

	test("says so when the session has no transcript here", async () => {
		const { root, bin, cachePath } = fixture();
		await expect(
			writeBrief({
				sessionId: "bbbb2222-0000-0000-0000-000000000000",
				claudeBin: bin,
				root,
				cachePath,
			}),
		).rejects.toThrow("No transcript on this machine");
	});
});

describe("warmBriefs", () => {
	/** The queue drains in the background; wait for the file it writes. */
	async function settle(cachePath: string, tries = 60) {
		for (let i = 0; i < tries; i++) {
			if (existsSync(cachePath)) return;
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	test("writes a brief before anyone opens the session", async () => {
		const { session, root, bin, cachePath, runCount } = fixture();
		const { queued } = await warmBriefs([session], {
			claudeBin: bin,
			root,
			cachePath,
		});
		expect(queued).toBe(1);
		await settle(cachePath);
		expect(runCount()).toBe(1);

		// Opening the drawer now costs a stat, not a model call.
		const opened = await writeBrief({
			sessionId: session,
			claudeBin: bin,
			root,
			cachePath,
		});
		expect(opened.cached).toBe(true);
		expect(runCount()).toBe(1);
	});

	test("hands back the written titles for the board to rename cards with", async () => {
		const { session, root, bin, cachePath } = fixture();
		await warmBriefs([session], { claudeBin: bin, root, cachePath });
		await settle(cachePath);
		const { titles } = await warmBriefs([session], {
			claudeBin: bin,
			root,
			cachePath,
		});
		expect(titles[session]).toBe("t");
	});

	test("queues a session once, however often the board re-fires", async () => {
		const { session, root, bin, cachePath, runCount } = fixture();
		await warmBriefs([session], { claudeBin: bin, root, cachePath });
		const second = await warmBriefs([session], {
			claudeBin: bin,
			root,
			cachePath,
		});
		expect(second.queued).toBe(0);
		await settle(cachePath);
		expect(runCount()).toBe(1);
	});

	test("a session with no transcript doesn't stall the queue", async () => {
		const { session, root, bin, cachePath, runCount } = fixture();
		warmBriefs(["cccc3333-0000-0000-0000-000000000000", session], {
			claudeBin: bin,
			root,
			cachePath,
		});
		await settle(cachePath);
		expect(runCount()).toBe(1);
	});
});

describe("parseBrief", () => {
	test("reads the three labelled lines", () => {
		const brief = parseBrief(
			[
				"GOAL: Create three $1-first-month coupon codes for the October EU conferences.",
				"STATUS: Confirmed it is data-only — 34 tests pass over the flat-fee path, no code change needed.",
				"NEXT: Waiting on marketing for the codes, end dates and per-currency amounts.",
			].join("\n"),
		);
		expect(brief.goal).toStartWith("Create three $1-first-month coupon");
		expect(brief.status).toContain("34 tests pass");
		expect(brief.next).toContain("Waiting on marketing");
		expect(brief.raw).toBeNull();
	});

	test("tolerates a chatty model: preamble, bold labels, blank lines", () => {
		const brief = parseBrief(
			[
				"Here is the brief:",
				"",
				"**GOAL**: Ship the session side panel.",
				"",
				"**STATUS**: Panel renders, 35 tests green.",
				"**NEXT**: Nothing — it's done.",
			].join("\n"),
		);
		expect(brief.goal).toBe("Ship the session side panel.");
		expect(brief.status).toBe("Panel renders, 35 tests green.");
		expect(brief.next).toBe("Nothing — it's done.");
	});

	test("reads a title a card can show, unquoted and cut to fit", () => {
		expect(parseBrief('TITLE: "Rename the board cards."\nGOAL: x').title).toBe(
			"Rename the board cards",
		);
		expect(parseBrief(`TITLE: ${"x".repeat(80)}`).title).toHaveLength(60);
		expect(parseBrief("GOAL: x").title).toBeNull();
	});

	test("keeps an off-shape answer rather than showing an empty panel", () => {
		const brief = parseBrief("I could not determine what this session is for.");
		expect(brief.goal).toBeNull();
		expect(brief.raw).toBe("I could not determine what this session is for.");
	});

	test("keeps the tags on the list and drops the invented ones", () => {
		const brief = parseBrief(
			[
				"GOAL: Stop the feed nagging about sources you never signed in to.",
				"STATUS: Tab now says so instead.",
				"NEXT: Nothing — it's done.",
				"TAGS: bug, #DOCS, frontend, bug",
			].join("\n"),
		);
		// Cased, hashed and duplicated all resolve; "frontend" isn't a tag we have
		// — nor is "ui" any more, the vocabulary is five words now.
		expect(brief.tags).toEqual(["bug", "docs"]);
	});

	test("caps the tags so a card stays readable", () => {
		const brief = parseBrief(
			"GOAL: x\nSTATUS: y\nNEXT: z\nTAGS: bug, chore, docs, infra",
		);
		expect(brief.tags).toEqual(["bug", "chore"]);
	});

	test("a session the model can't place gets no tags, not a wrong one", () => {
		expect(parseBrief("GOAL: x\nSTATUS: y\nNEXT: z\nTAGS:").tags).toEqual([]);
		expect(parseBrief("GOAL: x\nSTATUS: y\nNEXT: z").tags).toEqual([]);
	});

	test("an empty answer is empty, not a blank summary", () => {
		expect(parseBrief("   ")).toEqual({
			title: null,
			goal: null,
			status: null,
			next: null,
			tags: [],
			raw: null,
		});
	});
});

describe("digest", () => {
	const turn = (role: "user" | "assistant", text: string) => ({
		role,
		text,
		at: null,
	});

	test("labels the speakers and keeps the recent tail", () => {
		const messages = Array.from({ length: 30 }, (_, i) =>
			turn(i % 2 ? "assistant" : "user", `turn ${i}`),
		);
		const text = digest({ title: "T", prompt: "the ask", messages });
		expect(text).toContain("TITLE: T");
		expect(text).toContain("OPENING REQUEST:\nthe ask");
		expect(text).toContain("[HUMAN]");
		expect(text).toContain("[AGENT]");
		expect(text).toContain("turn 29");
		// The oldest turns are dropped, not the newest.
		expect(text).not.toContain("turn 5 ");
	});

	test("a long turn loses its middle, never its conclusion", () => {
		const text = digest({
			title: null,
			prompt: null,
			messages: [turn("assistant", `START${"x".repeat(4000)}CONCLUSION`)],
		});
		expect(text).toContain("START");
		expect(text).toContain("CONCLUSION");
		expect(text).toContain("…");
		expect(text.length).toBeLessThan(2000);
	});

	test("omits sections the transcript doesn't have", () => {
		const text = digest({ title: null, prompt: null, messages: [] });
		expect(text).not.toContain("TITLE");
		expect(text).not.toContain("OPENING REQUEST");
	});
});
