import { expect, it } from "bun:test";
import { duplicateSessions } from "./duplicate-sessions";
import type { Pane } from "./tabs-types";

const pane = (p: Partial<Pane> & { id: string }): Pane =>
	({ type: "terminal", ...p }) as Pane;

it("pairs the same ask arriving twice, and nothing else", () => {
	const found = duplicateSessions([
		// The real pair: Richu's DM and Richu's channel post, two cards.
		pane({
			id: "dm",
			odinTaskTitle: "Feature flag visibility for CS on TP",
			odinContact: "Richu Joseph George",
			odinPageId: "D0ARNCW6DN1:1790165128.883119",
		}),
		pane({
			id: "channel",
			odinTaskTitle: "Feature flag removal and TP tag tracking",
			odinContact: "Richu Joseph George",
			odinPageId: "C0B89CGHN48:1790171273.871159",
		}),
		// Same person, different job: one shared word isn't enough.
		pane({
			id: "abuse",
			odinTaskTitle: "TouchPoint user abuse investigation",
			odinContact: "Richu Joseph George",
		}),
		// Same symptom, different customers and root causes — not a duplicate.
		pane({
			id: "jira-color",
			odinTaskTitle: "Color profile preview mismatch (BUGT-4008)",
			odinContact: "Vanessa Li",
		}),
		pane({
			id: "slack-color",
			odinTaskTitle: "Preview color profile special character handling",
			odinContact: "Tamir Davidov",
		}),
		// Same person, two tickets: the shared "BUGT" prefix doesn't count.
		pane({
			id: "jira-download",
			odinTaskTitle: "BUGT-4032 — error 3010 image download 404",
			odinContact: "Vanessa Li",
		}),
		// The ticket and the Slack thread about it.
		pane({
			id: "ticket",
			odinTaskTitle: "CRR-905 GDPR for unified projects",
			odinContact: "Laurie Jensen",
		}),
		pane({
			id: "thread",
			odinTaskTitle: "Studio photos left after deletion",
			odinContact: "Ilan Atri",
			odinBrief: "any news on CRR-905? customer is asking again",
		}),
		// One Slack message started twice.
		pane({ id: "first", odinTaskTitle: "Deploy MCP", odinPageId: "C1:1.2" }),
		pane({ id: "again", odinTaskTitle: "Ship server", odinPageId: "C1:1.2" }),
	]);
	expect(Object.fromEntries(found)).toEqual({
		dm: "channel",
		channel: "dm",
		ticket: "thread",
		thread: "ticket",
		first: "again",
		again: "first",
	});
});
