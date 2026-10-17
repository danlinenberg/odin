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
};
const native = (window as { Capacitor?: Native }).Capacitor?.nativePromise;

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

export function useSpeech(onText: (text: string) => void) {
	const [listening, setListening] = useState(false);
	// Between tapping stop and the words arriving: iOS finishes the last phrase.
	const [transcribing, setTranscribing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const web = useRef<Recognition | null>(null);

	const heard = (text: string) => {
		setListening(false);
		setTranscribing(false);
		if (text.trim()) onText(text.trim());
	};

	async function toggle() {
		setError(null);
		if (native) {
			try {
				if (listening) {
					setTranscribing(true);
					const result = await native("OdinSpeech", "stop");
					heard(result?.text ?? "");
				} else {
					await native("OdinSpeech", "start");
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
		recognition.interimResults = false;
		recognition.lang = navigator.language;
		let text = "";
		recognition.onresult = (event) => {
			text = Array.from(event.results, (result) => result[0]?.transcript ?? "")
				.join(" ")
				.replace(/\s+/g, " ");
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

	return { listening, transcribing, error, toggle };
}
