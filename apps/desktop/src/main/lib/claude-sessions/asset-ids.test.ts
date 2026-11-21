import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idsInToolInput, idsInUrl, isIdLike, urlQuery } from "./asset-ids";
import { searchSessions } from "./claude-sessions";

const DESIGN =
	"https://design.example.com/file/Ab3dEf9GhIjK2LmN/Acme-Brand-2026---Launch?node-id=2781-25404&t=xYz1AbC2dEf3-0";

describe("idsInUrl", () => {
	test("keeps ids, outermost first, and drops words and slugs", () => {
		expect(idsInUrl(DESIGN)).toEqual([
			"Ab3dEf9GhIjK2LmN",
			"2781-25404",
			"xYz1AbC2dEf3-0",
		]);
		expect(
			idsInUrl("https://mail.example.com/env/123/broadcasts/45/overview"),
		).toEqual(["123", "45"]);
	});

	test("not a URL: no ids", () => {
		expect(idsInUrl("not a url")).toEqual([]);
	});
});

describe("isIdLike", () => {
	test("numbers, joined numbers, uuids and mixed tokens; not words", () => {
		for (const id of [
			"45",
			"2781-25404",
			"Ab3dEf9GhIjK2LmN",
			"aaaa1111-2222-3333-4444-555566667777",
		])
			expect(isIdLike(id)).toBe(true);
		for (const word of ["7", "design", "Acme-Brand-2026", "overview", "v2"])
			expect(isIdLike(word)).toBe(false);
	});
});

describe("idsInToolInput", () => {
	test("reads id-named keys and URLs, ignores counts and sizes", () => {
		const ids = new Set<string>();
		idsInToolInput(
			{
				fileKey: "Ab3dEf9GhIjK2LmN",
				nodeId: "2781:25404",
				campaign_id: 45,
				limit: 50,
				width: 1400,
				note: `see ${DESIGN}`,
			},
			ids,
		);
		expect(ids.has("Ab3dEf9GhIjK2LmN")).toBe(true);
		expect(ids.has("2781-25404")).toBe(true);
		expect(ids.has("45")).toBe(true);
		expect(ids.has("50")).toBe(false);
		expect(ids.has("1400")).toBe(false);
	});
});

test("urlQuery only takes a lone URL", () => {
	expect(urlQuery(` ${DESIGN} `)).toBe(DESIGN);
	expect(urlQuery("fix the https://example.com/a page")).toBeNull();
});

/** A session Odin launched whose one tool call names `input`. */
function session(title: string, input: Record<string, unknown>): string {
	return [
		JSON.stringify({
			type: "user",
			cwd: "/Users/me/dev/app",
			promptSource: "typed",
			message: {
				role: "user",
				content: `Task: ${title}\n\n${title}\n\nWork in the current workspace.`,
			},
		}),
		JSON.stringify({
			type: "assistant",
			cwd: "/Users/me/dev/app",
			message: {
				role: "assistant",
				content: [
					{ type: "tool_use", id: "toolu_1", name: "get_design", input },
				],
			},
		}),
	].join("\n");
}

describe("searchSessions by URL", () => {
	test("lists the sessions on the URL's most specific id only", async () => {
		const root = mkdtempSync(join(tmpdir(), "asset-ids-"));
		const project = join(root, "-Users-me-dev-app");
		mkdirSync(project);
		const write = (id: string, text: string) =>
			writeFileSync(join(project, `${id}.jsonl`), text);
		write(
			"aaaa1111-0000-0000-0000-000000000001",
			session("hero frame copy", {
				fileKey: "Ab3dEf9GhIjK2LmN",
				nodeId: "2781:25404",
			}),
		);
		write(
			"aaaa1111-0000-0000-0000-000000000002",
			session("whole file review", { fileKey: "Ab3dEf9GhIjK2LmN" }),
		);
		write(
			"aaaa1111-0000-0000-0000-000000000003",
			session("something else", { fileKey: "Zz9yXw8VuTs7RqP" }),
		);

		const frame = await searchSessions({ root, query: DESIGN });
		expect(frame.sessions.map((s) => s.title)).toEqual(["hero frame copy"]);

		const file = await searchSessions({
			root,
			query: "https://design.example.com/file/Ab3dEf9GhIjK2LmN/Acme",
		});
		expect(file.sessions.map((s) => s.title).sort()).toEqual([
			"hero frame copy",
			"whole file review",
		]);

		const none = await searchSessions({
			root,
			query: "https://design.example.com/file/Qq1wE2rT3yU4iO5p/x",
		});
		expect(none.sessions).toEqual([]);
	});
});
