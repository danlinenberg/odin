import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Odin reads a reply out loud, on the renderer's own speech synthesis
 * (`speechSynthesis`, built into Electron on macOS - nothing to install). The
 * TL;DR is what gets read: it is the reply in a few lines, written to be said.
 * A reply with no TL;DR is read whole, without its action items.
 */

/** The speeds offered in Settings: the Web Speech rate, 1 being the voice's own pace. */
export const READ_ALOUD_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export const READ_ALOUD_RATE_DEFAULT = 1;
const MIN_RATE = 0.5;
const MAX_RATE = 2;

/** A rate the Web Speech API takes: 0.5x to 2x. Anything else is the voice's own pace. */
export function clampRate(rate: unknown): number {
	if (typeof rate !== "number" || !Number.isFinite(rate))
		return READ_ALOUD_RATE_DEFAULT;
	return Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
}

/**
 * Settings > Sessions > On the board: whether each new reply is read aloud,
 * and how fast. Renderer localStorage like idle-close: the chat view is the
 * only reader, and speech runs in the renderer.
 */
export const useReadAloud = create<{
	enabled: boolean;
	rate: number;
	setEnabled: (enabled: boolean) => void;
	setRate: (rate: number) => void;
}>()(
	persist(
		(set) => ({
			enabled: false,
			rate: READ_ALOUD_RATE_DEFAULT,
			setEnabled: (enabled) => set({ enabled }),
			setRate: (rate) => set({ rate: clampRate(rate) }),
		}),
		{ name: "odin-read-aloud" },
	),
);

/**
 * Markdown as words to say: code blocks dropped (they are for the eye), inline
 * code and emphasis marks gone, a link read as its text, headings, bullets and
 * quote marks off the line starts, a table's cells read in turn.
 */
export function spokenWords(markdown: string): string {
	return (
		markdown
			.replace(/```[\s\S]*?(?:```|$)/g, " ")
			.replace(/`([^`\n]*)`/g, "$1")
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			.replace(/<\/?[a-z][^<>\n]*>/gi, " ")
			.replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
			.replace(/^[ \t]*[-*+][ \t]+/gm, "")
			.replace(/^[ \t]*>[ \t]?/gm, "")
			.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")
			.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
			.replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?![\w*])/g, "$1$2")
			.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
			// A table: its separator row says nothing, its pipes become pauses.
			.replace(
				/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm,
				"",
			)
			.replace(/[ \t]*\|[ \t]*/g, ", ")
			.replace(/[ \t]+/g, " ")
			.replace(/^[ ,]+|[ ,]+$/gm, "")
			.replace(/\n{2,}/g, "\n")
			.trim()
	);
}

/**
 * What to say for a reply: its TL;DR when the brief wrote one, else the reply
 * itself. Null when there is nothing to say.
 */
export function spokenText(
	tldr: string | null | undefined,
	body: string | null | undefined,
): string | null {
	const words = spokenWords(tldr?.trim() ? tldr : (body ?? ""));
	return words || null;
}

/** The reply being read right now, by its item id - what the speaker buttons show. */
export const useSpeaking = create<{ id: string | null }>(() => ({ id: null }));

/** The renderer's speech synthesis, or null where there is none. */
function synth(): SpeechSynthesis | null {
	return typeof speechSynthesis === "undefined" ? null : speechSynthesis;
}

export function canSpeak(): boolean {
	return synth() !== null;
}

// Held so its end is ours to hear: Chromium lets go of an utterance nobody
// references mid-sentence, and its onend never fires.
let current: SpeechSynthesisUtterance | null = null;

/** Say `text` for the reply `id`, in place of whatever was being said. */
export function speak(id: string, text: string, rate: number): void {
	const voice = synth();
	if (!voice || !text.trim()) return;
	voice.cancel();
	const utterance = new SpeechSynthesisUtterance(text);
	utterance.rate = clampRate(rate);
	// cancel() ends the one before with an error; only this one's own end clears it.
	const done = () => {
		if (current !== utterance) return;
		current = null;
		useSpeaking.setState({ id: null });
	};
	utterance.onend = done;
	utterance.onerror = done;
	current = utterance;
	useSpeaking.setState({ id });
	voice.speak(utterance);
}

export function stopSpeaking(): void {
	synth()?.cancel();
	current = null;
	useSpeaking.setState({ id: null });
}
