import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addSamples,
	addVoiceNote,
	draftCorrections,
	LEARN_EVERY,
	learnFromDrafts,
	learnPrompt,
	myLines,
	noteConversation,
	readVoice,
	setVoiceEnabled,
	setVoiceNotes,
	trainingState,
	trainVoice,
	voiceStats,
	voiceText,
} from "./voice-profile";

const empty = {
	guide: "",
	samples: [],
	unlearned: 0,
	notes: [],
	updatedAt: null,
	enabled: true,
	trainedAt: null,
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

	test("the same message with and without its place counts once", () => {
		const once = addSamples(empty, ["[dm] a long enough line"]);
		expect(addSamples(once, ["a long enough line"])).toBe(once);
	});
});

describe("voiceStats", () => {
	test("counts length, capitals, periods, Hebrew and emoji from my messages", () => {
		const stats = voiceStats([
			"[dm] Ok will check it today",
			"[#devops] can you give me access?",
			"אגיע לזה היום :slightly_smiling_face:",
			"Merged it.",
		]);
		expect(stats).toContain("From my last 4 messages:");
		expect(stats).toContain("25% have Hebrew");
		expect(stats).toContain("67% start with a capital, 33% end with a period");
		expect(stats).toContain("25% ask a question");
		expect(stats).toContain(
			"Emoji in 25% of messages, mostly :slightly_smiling_face:",
		);
		expect(voiceStats([])).toBe("");
	});
});

describe("learnPrompt and voiceText", () => {
	test("the prompt carries the numbers, corrections, last guide and my newest messages", () => {
		const samples = Array.from(
			{ length: 300 },
			(_, i) => `message number ${i} here`,
		);
		const prompt = learnPrompt({
			...empty,
			guide: "Short and lowercase.",
			notes: ["no emoji"],
			samples,
		});
		expect(prompt).toContain("Short and lowercase.");
		expect(prompt).toContain("- no emoji");
		expect(prompt).toContain("From my last 250 messages:");
		expect(prompt).toContain("- message number 299 here");
		expect(prompt).not.toContain("- message number 49 here");
	});

	test("corrections lead the guide; nothing known prints nothing", () => {
		expect(voiceText(empty)).toBe("");
		expect(voiceText({ ...empty, guide: "G", enabled: false })).toBe("");
		expect(voiceText({ ...empty, guide: "G", notes: ["shorter"] })).toBe(
			"Corrections I made, oldest first - always follow these. When two disagree, the later one wins:\n- shorter\n\nG",
		);
		expect(
			voiceText({ ...empty, guide: "G", samples: ["a message of mine"] }),
		).toContain("G\n\nFrom my last 1 messages:");
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

describe("trainVoice", () => {
	const fakeClaude = join(tmpdir(), `fake-claude-train-${process.pid}.sh`);
	writeFileSync(fakeClaude, "#!/bin/sh\necho 'Terse.'\n", { mode: 0o755 });

	test("learns from sent messages right away, newest kept last", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "voice-")), "voice.json");
		await trainVoice(
			async () => ["newest message of mine", "ok", "older message of mine"],
			{
				path,
				claudeBin: fakeClaude,
			},
		);
		const store = await readVoice(path);
		expect(store.samples).toEqual([
			"older message of mine",
			"newest message of mine",
		]);
		expect(store.guide).toBe("Terse.");
		expect(store.trainedAt).not.toBeNull();
		expect(trainingState()).toEqual({ training: false, error: null });
	});

	test("a Slack refusal is the error Settings shows", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "voice-")), "voice.json");
		await trainVoice(
			async () => {
				throw new Error("Reconnect Slack");
			},
			{ path, claudeBin: fakeClaude },
		);
		expect(trainingState().error).toBe("Reconnect Slack");
	});

	test("off keeps nothing; corrections are edited as a list", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "voice-")), "voice.json");
		await setVoiceEnabled(false, path);
		await noteConversation("ME: a message while it is off", { path });
		await trainVoice(async () => ["a message while it is off"], { path });
		expect((await readVoice(path)).samples).toEqual([]);
		await setVoiceNotes(["shorter", "", " shorter ", "no emoji"], path);
		expect((await readVoice(path)).notes).toEqual(["shorter", "no emoji"]);
	});
});

describe("learnFromDrafts", () => {
	const fakeClaude = join(tmpdir(), `fake-claude-drafts-${process.pid}.sh`);
	writeFileSync(
		fakeClaude,
		"#!/bin/sh\necho '- shorter, no greeting'\necho '- no sign-off'\n",
		{ mode: 0o755 },
	);
	const pairs = [
		{
			draft: "Hi Nati! The deploy is fixed now. Let me know. Thanks, Dan",
			sent: ["deploy fixed, check again"],
		},
		{ draft: "never sent this one", sent: [] },
	];

	test("how I rewrote a draft becomes corrections, what I sent a sample", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "voice-")), "voice.json");
		await learnFromDrafts(pairs, { path, claudeBin: fakeClaude });
		const store = await readVoice(path);
		expect(store.notes).toEqual(["shorter, no greeting", "no sign-off"]);
		expect(store.samples).toEqual(["deploy fixed, check again"]);
	});

	test("does nothing while Your voice is off", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "voice-")), "voice.json");
		await setVoiceEnabled(false, path);
		await learnFromDrafts(pairs, { path, claudeBin: fakeClaude });
		const store = await readVoice(path);
		expect(store.notes).toEqual([]);
		expect(store.samples).toEqual([]);
	});

	test("NONE adds no correction", () => {
		expect(draftCorrections("NONE")).toEqual([]);
		expect(draftCorrections("- a\n- b\n- c\n- d")).toEqual(["a", "b", "c"]);
	});
});
