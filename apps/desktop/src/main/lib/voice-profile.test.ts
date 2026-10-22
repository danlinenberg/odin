import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addSamples,
	addVoiceNote,
	LEARN_EVERY,
	learnPrompt,
	myLines,
	noteConversation,
	readVoice,
	voiceText,
} from "./voice-profile";

const empty = {
	guide: "",
	samples: [],
	unlearned: 0,
	notes: [],
	updatedAt: null,
};

describe("myLines", () => {
	test("keeps my lines, drops others, bare links, emoji and file rows", () => {
		const text = [
			"Nati: can you check the deploy?",
			"ME: yep, looking now - give me 5 min",
			"ME [QUEUED]: did anyone touch the HDR queue today?",
			"ME: <https://x.slack.com/archives/C1/p1>",
			"ME: :+1:",
			"  [file a.png] curl ...",
		].join("\n");
		expect(myLines(text)).toEqual([
			"yep, looking now - give me 5 min",
			"did anyone touch the HDR queue today?",
		]);
	});
});

describe("addSamples", () => {
	test("counts only new lines", () => {
		const once = addSamples(empty, [
			"a long enough line",
			"a long enough line",
		]);
		expect(once.samples).toEqual(["a long enough line"]);
		expect(once.unlearned).toBe(1);
		expect(addSamples(once, ["a long enough line"])).toBe(once);
	});
});

describe("learnPrompt and voiceText", () => {
	test("the prompt carries the last guide, corrections and new samples", () => {
		const prompt = learnPrompt({
			...empty,
			guide: "Short and lowercase.",
			notes: ["no emoji"],
			samples: ["old one here", "new one here"],
			unlearned: 1,
		});
		expect(prompt).toContain("Short and lowercase.");
		expect(prompt).toContain("- no emoji");
		expect(prompt.indexOf("old one here")).toBeLessThan(
			prompt.indexOf("Messages I wrote since"),
		);
		expect(prompt.indexOf("new one here")).toBeGreaterThan(
			prompt.indexOf("Messages I wrote since"),
		);
	});

	test("corrections lead the guide; nothing known prints nothing", () => {
		expect(voiceText(empty)).toBe("");
		expect(voiceText({ ...empty, guide: "G", notes: ["shorter"] })).toBe(
			"Corrections I made - always follow these:\n- shorter\n\nG",
		);
	});
});

describe("noteConversation", () => {
	const fakeClaude = join(tmpdir(), `fake-claude-voice-${process.pid}.sh`);
	writeFileSync(
		fakeClaude,
		"#!/bin/sh\necho 'Short, lowercase, no sign-off.'\n",
		{
			mode: 0o755,
		},
	);

	test("keeps samples, and relearns the guide once enough are new", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "voice-")), "voice.json");
		await noteConversation("ME: first message of mine here", {
			path,
			claudeBin: fakeClaude,
		});
		let store = await readVoice(path);
		expect(store.samples).toEqual(["first message of mine here"]);
		expect(store.guide).toBe("");

		const many = Array.from(
			{ length: LEARN_EVERY },
			(_, i) => `ME: another message number ${i}`,
		).join("\n");
		await noteConversation(many, { path, claudeBin: fakeClaude });
		store = await readVoice(path);
		expect(store.guide).toBe("Short, lowercase, no sign-off.");
		expect(store.unlearned).toBe(0);

		await addVoiceNote("  no   emoji ", path);
		await addVoiceNote("no emoji", path);
		expect((await readVoice(path)).notes).toEqual(["no emoji"]);
	});
});
