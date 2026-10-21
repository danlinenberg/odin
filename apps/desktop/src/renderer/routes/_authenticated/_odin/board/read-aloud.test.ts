import { beforeEach, describe, expect, test } from "bun:test";
import {
	canSpeak,
	clampRate,
	READ_ALOUD_RATES,
	speak,
	spokenText,
	spokenWords,
	stopSpeaking,
	useReadAloud,
	useSpeaking,
} from "./read-aloud";

/** A speechSynthesis that records what it was asked to say. */
class FakeUtterance {
	text: string;
	rate = 1;
	onend: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(text: string) {
		this.text = text;
	}
}
const said: FakeUtterance[] = [];
let cancels = 0;
const fakeSynth = {
	speak: (utterance: FakeUtterance) => {
		said.push(utterance);
	},
	cancel: () => {
		cancels += 1;
	},
};

function installSynth() {
	Object.defineProperty(globalThis, "speechSynthesis", {
		value: fakeSynth,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
		value: FakeUtterance,
		configurable: true,
		writable: true,
	});
}

beforeEach(() => {
	said.length = 0;
	cancels = 0;
	installSynth();
	useSpeaking.setState({ id: null });
});

describe("clampRate", () => {
	test("keeps a rate between 0.5x and 2x", () => {
		expect(clampRate(0.1)).toBe(0.5);
		expect(clampRate(1.25)).toBe(1.25);
		expect(clampRate(3)).toBe(2);
	});

	test("anything that is not a number is the voice's own pace", () => {
		expect(clampRate(Number.NaN)).toBe(1);
		expect(clampRate("fast")).toBe(1);
		expect(clampRate(undefined)).toBe(1);
	});

	test("every offered speed is already in range", () => {
		for (const rate of READ_ALOUD_RATES) expect(clampRate(rate)).toBe(rate);
	});
});

describe("useReadAloud", () => {
	test("starts off at the voice's own pace", () => {
		expect(useReadAloud.getState().enabled).toBe(false);
		expect(useReadAloud.getState().rate).toBe(1);
	});

	test("remembers the switch and a clamped speed", () => {
		useReadAloud.getState().setEnabled(true);
		useReadAloud.getState().setRate(9);
		expect(useReadAloud.getState()).toMatchObject({ enabled: true, rate: 2 });
		const saved = JSON.parse(localStorage.getItem("odin-read-aloud") ?? "{}");
		expect(saved.state).toMatchObject({ enabled: true, rate: 2 });
		useReadAloud.getState().setEnabled(false);
		useReadAloud.getState().setRate(1);
	});
});

describe("spokenWords", () => {
	test("reads a link as its text and drops code and emphasis marks", () => {
		expect(
			spokenWords(
				"Opened [PR #12](https://github.com/x/y/pull/12) - **merged** `lint` _fix_.",
			),
		).toBe("Opened PR #12 - merged lint fix.");
	});

	test("says nothing for a code block, and reads the prose around it", () => {
		expect(spokenWords("Run this:\n\n```sh\nbun test\n```\n\nThen push.")).toBe(
			"Run this:\nThen push.",
		);
	});

	test("takes headings, bullets, quotes and rules off the line starts", () => {
		expect(spokenWords("## Done\n- one\n* two\n> said\n---\n1. three")).toBe(
			"Done\none\ntwo\nsaid\n1. three",
		);
	});

	test("reads a table's cells in turn", () => {
		expect(spokenWords("| File | State |\n|---|---|\n| a.ts | ok |")).toBe(
			"File, State\na.ts, ok",
		);
	});

	test("leaves snake_case and a lone asterisk alone", () => {
		expect(spokenWords("set max_rate to 2 * 3")).toBe("set max_rate to 2 * 3");
	});
});

describe("spokenText", () => {
	test("the TL;DR first, the reply when there is none", () => {
		expect(spokenText("**Merged** the PR.", "Long reply...")).toBe(
			"Merged the PR.",
		);
		expect(spokenText(null, "Long reply...")).toBe("Long reply...");
		expect(spokenText("  ", "Long reply...")).toBe("Long reply...");
	});

	test("null when there is nothing to say", () => {
		expect(spokenText(null, "")).toBeNull();
		expect(spokenText(undefined, "```\ncode only\n```")).toBeNull();
	});
});

describe("speak", () => {
	test("says the text at the clamped rate and marks the reply as being read", () => {
		expect(canSpeak()).toBe(true);
		speak("r1", "Merged the PR.", 5);
		expect(said).toHaveLength(1);
		expect(said[0]).toMatchObject({ text: "Merged the PR.", rate: 2 });
		expect(useSpeaking.getState().id).toBe("r1");
		said[0]?.onend?.();
		expect(useSpeaking.getState().id).toBeNull();
	});

	test("a new reply cuts the one before, whose late end does not clear it", () => {
		speak("r1", "First.", 1);
		speak("r2", "Second.", 1);
		expect(cancels).toBe(2);
		expect(useSpeaking.getState().id).toBe("r2");
		said[0]?.onerror?.();
		expect(useSpeaking.getState().id).toBe("r2");
		said[1]?.onend?.();
		expect(useSpeaking.getState().id).toBeNull();
	});

	test("stop cancels and clears", () => {
		speak("r1", "First.", 1);
		stopSpeaking();
		expect(cancels).toBe(2);
		expect(useSpeaking.getState().id).toBeNull();
	});

	test("nothing to say, nothing said", () => {
		speak("r1", "   ", 1);
		expect(said).toHaveLength(0);
		expect(useSpeaking.getState().id).toBeNull();
	});

	test("no speech synthesis, no speech", () => {
		Object.defineProperty(globalThis, "speechSynthesis", {
			value: undefined,
			configurable: true,
			writable: true,
		});
		expect(canSpeak()).toBe(false);
		speak("r1", "Merged.", 1);
		expect(said).toHaveLength(0);
		expect(useSpeaking.getState().id).toBeNull();
	});
});
