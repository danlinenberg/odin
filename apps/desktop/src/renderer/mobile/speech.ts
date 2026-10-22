import { useRef, useState } from "react";

/**
 * Speech to text for the phone's text boxes, on the phone itself: in the iOS
 * app the OdinSpeech plugin (apps/mobile/ios/App/App/OdinSpeech.swift, iOS
 * speech recognition); in a browser (`bun run dev`), its own SpeechRecognition. Tap to
 * start, tap to stop; the words go into the box to edit before sending.
 */

type Native = {
	nativePromise?: (
		plugin: string,
		method: string,
		options?: object,
	) => Promise<{ text?: string } | undefined>;
	addListener?: (
		plugin: string,
		event: string,
		callback: (data: { text?: string }) => void,
	) => { remove: () => void };
};
const capacitor = (window as { Capacitor?: Native }).Capacitor;
const native = capacitor?.nativePromise;

/** The browser's recognizer; lib.dom types its events but not the class. */
type Recognition = {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: SpeechRecognitionEvent) => void) | null;
	onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
	onend: (() => void) | null;
	start: () => void;
	stop: () => void;
};
// Missing from older WebKit, and maybe from the iOS app's web view.
const speechWindow = window as unknown as Record<
	"SpeechRecognition" | "webkitSpeechRecognition",
	(new () => Recognition) | undefined
>;
const WebSpeech =
	speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;

export const speechAvailable = !!native || !!WebSpeech;

/**
 * iOS answers `stop` within about 1.5s (OdinSpeech.swift). If the answer
 * never reaches the web view, give up waiting and keep the words shown live,
 * so "Transcribing" can't spin forever.
 */
const STOP_TIMEOUT_MS = 4000;
const stopNative = async (fallback: string): Promise<string> => {
	const timeout = new Promise<undefined>((resolve) =>
		setTimeout(() => resolve(undefined), STOP_TIMEOUT_MS),
	);
	const result = await Promise.race([native?.("OdinSpeech", "stop"), timeout]);
	return result?.text ?? fallback;
};

/** Words to favor when listening: the board's titles, repos and people. */
let vocabulary: string[] = [];
export const setVocabulary = (words: string[]) => {
	vocabulary = words;
};

/**
 * What a recognizer gets wrong on the board: names (repos, people) whole, and
 * from titles the words that are not plain English - a capital or a digit
 * after the first letter (GraphQL, EC2, PAY-212), or a capital after the
 * first word (Maya, Odin). "Fix" opening a title is plain English.
 */
export function boardWords(titles: string[], names: string[]): string[] {
	const words = new Set(names.filter(Boolean));
	for (const title of titles)
		title.split(/\s+/).forEach((raw, index) => {
			const word = raw.replace(/^[^\w]+|[^\w]+$/g, "").replace(/'s$/, "");
			if (word.length < 2) return;
			if (/[A-Z0-9]/.test(word.slice(1)) || (index > 0 && /^[A-Z]/.test(word)))
				words.add(word);
		});
	return [...words].slice(0, 75);
}

export function useSpeech(onText: (text: string) => void) {
	const [listening, setListening] = useState(false);
	// Between tapping stop and the words arriving: iOS finishes the last phrase.
	const [transcribing, setTranscribing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** The words so far, while you talk. */
	const [live, setLive] = useState("");
	// The live words for stopNative's fallback, outside the render's closure.
	const liveText = useRef("");
	const partial = useRef<{ remove: () => void } | null>(null);
	const web = useRef<Recognition | null>(null);
	// Set by finish(): the words go to its caller, not into the box.
	const finishing = useRef<((text: string) => void) | null>(null);

	const heard = (text: string) => {
		partial.current?.remove();
		partial.current = null;
		liveText.current = "";
		setLive("");
		setListening(false);
		setTranscribing(false);
		if (finishing.current) {
			finishing.current(text.trim());
			finishing.current = null;
			return;
		}
		if (text.trim()) onText(text.trim());
	};

	async function toggle() {
		setError(null);
		if (native) {
			try {
				if (listening) {
					setTranscribing(true);
					heard(await stopNative(liveText.current));
				} else {
					partial.current?.remove();
					partial.current =
						capacitor?.addListener?.("OdinSpeech", "partial", (data) => {
							liveText.current = data.text ?? "";
							setLive(liveText.current);
						}) ?? null;
					await native("OdinSpeech", "start", { words: vocabulary });
					setListening(true);
				}
			} catch (failure) {
				setListening(false);
				setTranscribing(false);
				// The bridge rejects with the plugin's { message, code }, not an Error.
				setError(
					(failure as { message?: string } | null)?.message ?? String(failure),
				);
			}
			return;
		}
		if (!WebSpeech) return;
		if (listening) {
			setTranscribing(true);
			return web.current?.stop();
		}
		const recognition = new WebSpeech();
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = navigator.language;
		let text = "";
		recognition.onresult = (event) => {
			text = Array.from(event.results, (result) => result[0]?.transcript ?? "")
				.join(" ")
				.replace(/\s+/g, " ");
			setLive(text);
		};
		recognition.onerror = (event) => {
			if (event.error !== "aborted" && event.error !== "no-speech")
				setError(`Speech recognition: ${event.error}`);
		};
		recognition.onend = () => heard(text);
		web.current = recognition;
		recognition.start();
		setListening(true);
	}

	/**
	 * Stop and hand back what was heard, for Send pressed mid-dictation: one
	 * tap sends it, no stop first. "" when nothing was recording.
	 */
	async function finish(): Promise<string> {
		if (!listening) return "";
		setTranscribing(true);
		if (native) {
			try {
				return (await stopNative(liveText.current)).trim();
			} catch {
				return "";
			} finally {
				partial.current?.remove();
				partial.current = null;
				liveText.current = "";
				setLive("");
				setListening(false);
				setTranscribing(false);
			}
		}
		return new Promise((resolve) => {
			if (!web.current) return resolve("");
			finishing.current = resolve;
			web.current.stop();
		});
	}

	return { listening, transcribing, live, error, toggle, finish };
}
