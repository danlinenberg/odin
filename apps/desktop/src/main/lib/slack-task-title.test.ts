import { describe, expect, test } from "bun:test";
import {
	conversationForTitle,
	parseTitle,
	titlePrompt,
} from "./slack-task-title";

describe("parseTitle", () => {
	test("reads the TITLE line, without quotes or a full stop", () => {
		expect(parseTitle('TITLE: "Export stuck for Acme photos".')).toBe(
			"Export stuck for Acme photos",
		);
		expect(parseTitle("Sure.\n**TITLE**: HDR merge timeout\n")).toBe(
			"HDR merge timeout",
		);
	});

	test("an empty TITLE is an answer: nothing to call it", () => {
		expect(parseTitle("TITLE:\n")).toBe("");
		expect(parseTitle("TITLE:   ")).toBe("");
	});

	test("a lone short line is the title; prose is no answer", () => {
		expect(parseTitle("Billing retry for EU cards\n")).toBe(
			"Billing retry for EU cards",
		);
		expect(
			parseTitle("I read the thread.\nIt is about billing.\nHope that helps"),
		).toBeNull();
		expect(parseTitle("")).toBeNull();
	});

	test("cut to a card's width", () => {
		expect(
			parseTitle(`TITLE: ${"word ".repeat(30)}`)?.length,
		).toBeLessThanOrEqual(60);
	});
});

describe("conversationForTitle", () => {
	test("drops the file download lines a session would run", () => {
		const read = [
			"Dana: the export is stuck",
			'  [file a.png] curl -sfG "http://127.0.0.1:$ODIN_PORT/file" -o <path>',
			"ME [QUEUED]: looking",
		].join("\n");
		expect(conversationForTitle(read, "looking")).toBe(
			"Dana: the export is stuck\nME [QUEUED]: looking",
		);
	});

	test("falls back to the message itself when the thread can't be read", () => {
		expect(conversationForTitle(null, "can you look?")).toBe(
			"ME [QUEUED]: can you look?",
		);
	});
});

describe("titlePrompt", () => {
	test("rules first, then the conversation as data", () => {
		const prompt = titlePrompt("Dana: the export is stuck");
		expect(prompt).toContain("TITLE:");
		expect(
			prompt.endsWith("--- CONVERSATION ---\nDana: the export is stuck"),
		).toBe(true);
	});
});
