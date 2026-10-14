import { toast } from "@odin/ui/sonner";
import { useEffect, useRef, useState } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";

/**
 * Hold-to-talk for the chat box, on Claude Code's own voice mode: Odin holds
 * Space in the session's PTY (a stream of spaces, like a held key's repeat),
 * Claude records and transcribes into its prompt, and Odin moves that text
 * into the chat box. Nothing to install: Claude Code bundles the recorder
 * and transcribes with the account it is signed in with.
 */

const RULE_RE = /^\s*[─━═]{3,}\s*$/;
// The level meter Claude draws after the cursor while it records.
const METER_RE = /[▁▂▃▄▅▆▇█]+\s*$/;

// Claude's grey hint in an empty input box: `Try "fix lint errors"`.
const HINT_RE = /^Try ".*"$/;

/** Where Claude's input box starts: its `❯` line, below a rule. */
function inputLine(lines: string[]): number {
	for (let i = lines.length - 1; i > 0; i--)
		if (
			(lines[i] ?? "").trimStart().startsWith("❯") &&
			RULE_RE.test(lines[i - 1] ?? "")
		)
			return i;
	return -1;
}

/** The text in Claude's input box (the `❯` line between the two rules). */
export function promptText(screen: string): string | null {
	const lines = screen.split("\n");
	const i = inputLine(lines);
	if (i < 0) return null;
	const parts = [(lines[i] ?? "").trimStart().slice(1).trim()];
	for (let j = i + 1; j < lines.length && !RULE_RE.test(lines[j] ?? ""); j++)
		parts.push((lines[j] ?? "").trim());
	const text = parts.join(" ").replace(METER_RE, "").trim();
	return HINT_RE.test(text) ? "" : text;
}

export type VoiceState = "recording" | "processing" | "idle";

/**
 * Claude's voice state, read from its input box and the footer under it only:
 * the conversation above can quote "Voice: processing" or "listening…" too.
 */
export function voiceState(screen: string): VoiceState {
	const lines = screen.split("\n");
	const i = inputLine(lines);
	if (i < 0) return "idle";
	const box = lines.slice(i - 1).join("\n");
	if (/Voice: processing/.test(box)) return "processing";
	// The words sit at the right end of the status line, and a wide status
	// line pushes them off screen. The level meter at the cursor doesn't move.
	if (
		/keep holding|listening…|listening\.\.\./.test(box) ||
		METER_RE.test(lines[i] ?? "")
	)
		return "recording";
	return "idle";
}

/** Claude heard nothing: it says so in the footer and leaves the box empty. */
export function noSpeech(screen: string): boolean {
	const lines = screen.split("\n");
	const i = inputLine(lines);
	return i >= 0 && /No speech detected/.test(lines.slice(i - 1).join("\n"));
}

const HOLD_MS = 300; // a tap types a space, a hold talks
const REPEAT_MS = 30; // a held key's repeat rate
const NO_VOICE_MS = 1500; // no "keep holding" by now: voice is off in Claude
const DONE_MS = 20_000;

/**
 * After the release, the box holds Claude's final text once it sat still
 * `stillMs`. Claude shows "Voice: processing" until it is done, so after that
 * one quiet read is enough. A wide status line can hide that hint: then wait
 * longer, and longest for an empty box - when Claude hears nothing it clears
 * the box and says nothing.
 */
export function settled(sawProcessing: boolean, text: string, stillMs: number) {
	return stillMs >= (sawProcessing ? 0 : text ? 1000 : 3000);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Hold = {
	timer?: ReturnType<typeof setTimeout>;
	/** Lets the held Space go. */
	pump?: () => void;
	released: boolean;
};

/**
 * `press` starts a hold, `release` ends it. A press shorter than HOLD_MS
 * calls `onTap` instead. While listening, `heard` is what Claude has
 * transcribed so far; `onText` gets the final text.
 */
export function useHoldToTalk({
	paneId,
	onText,
	onTap,
}: {
	paneId: string;
	onText: (text: string) => void;
	onTap?: () => void;
}) {
	const [phase, setPhase] = useState<"idle" | "listening" | "processing">(
		"idle",
	);
	const [heard, setHeard] = useState("");
	const hold = useRef<Hold | null>(null);
	const latest = useRef({ onText, onTap });
	latest.current = { onText, onTap };

	const write = (data: string) =>
		electronTrpcClient.terminal.write.mutate({ paneId, data });
	const read = async () =>
		(
			await electronTrpcClient.terminal.readScreen
				.query({ paneId })
				.catch(() => null)
		)?.text ?? "";

	/**
	 * Hold Space down in Claude's terminal. The repeats are timed in the main
	 * process or the daemon, next to the PTY: Claude lets the key go at a
	 * 100ms gap between two of them, and this window stalls that long while
	 * it draws a long chat - which is how a hold turned into typed spaces.
	 */
	const startPump = async (): Promise<() => void> => {
		try {
			await electronTrpcClient.terminal.holdKey.mutate({
				paneId,
				data: " ",
				everyMs: REPEAT_MS,
			});
			return () =>
				void electronTrpcClient.terminal.releaseKey
					.mutate({ paneId })
					.catch(() => undefined);
		} catch {
			// An Odin whose main process predates holdKey: time it here.
			const id = setInterval(() => void write(" "), REPEAT_MS);
			return () => clearInterval(id);
		}
	};

	const stopPump = () => {
		const h = hold.current;
		h?.pump?.();
		if (h) h.pump = undefined;
	};

	const listen = async (h: Hold) => {
		const before = promptText(await read());
		// No input box on screen (a menu or a permission prompt): a held Space
		// there picks options, so send nothing.
		if (before === null) {
			hold.current = null;
			toast("Claude is not at its input box", {
				description: "Answer what Claude shows first, then hold Space to talk.",
			});
			return;
		}
		setPhase("listening");
		setHeard("");
		h.pump = await startPump();
		// Let go while the pump was starting: stop it before anything else.
		if (h.released) stopPump();
		let seen = false;
		const started = Date.now();
		while (!h.released) {
			await sleep(200);
			const screen = await read();
			if (voiceState(screen) !== "idle") seen = true;
			const text = promptText(screen);
			if (seen && text && text !== before) setHeard(text);
			if (!seen && Date.now() - started > NO_VOICE_MS) break;
		}
		stopPump();
		if (!seen) {
			// Voice is off: those spaces were typed into Claude's prompt.
			await write("\x15");
			setPhase("idle");
			hold.current = null;
			toast("Voice is off in Claude Code", {
				description: "Turn it on once, then hold Space to talk.",
				action: {
					label: "Turn on",
					onClick: () =>
						void write("/voice hold").then(async () => {
							await sleep(30);
							await write("\r");
						}),
				},
			});
			return;
		}
		setPhase("processing");
		let text: string | null = null;
		let last: string | null = null;
		let since = Date.now();
		let sawProcessing = false;
		for (const end = Date.now() + DONE_MS; Date.now() < end; ) {
			await sleep(250);
			const screen = await read();
			if (noSpeech(screen)) break;
			const state = voiceState(screen);
			if (state === "processing") sawProcessing = true;
			const now = state === "idle" ? promptText(screen) : null;
			if (now === null || now !== last) {
				last = now;
				since = Date.now();
			} else if (settled(sawProcessing, now, Date.now() - since)) {
				text = now;
				break;
			}
		}
		if (text && text !== before) {
			// Claude's prompt goes back to empty; the text lives in Odin's box.
			await write("\x15");
			latest.current.onText(text);
		} else if (!text) {
			// Nothing heard: clear what the hold left in Claude's box (a
			// dropped hold types its spaces), so the next hold starts clean.
			await write("\x15");
			toast("Claude heard nothing", {
				description:
					"It records from the Mac's default input. Check System Settings > Sound > Input (a closed MacBook lid mutes its microphone).",
			});
		}
		setPhase("idle");
		setHeard("");
		hold.current = null;
	};

	const press = (immediate = false) => {
		if (hold.current) return;
		const h: Hold = { released: false };
		hold.current = h;
		const start = () => {
			h.timer = undefined;
			void listen(h);
		};
		if (immediate) start();
		else h.timer = setTimeout(start, HOLD_MS);
	};

	const release = () => {
		const h = hold.current;
		if (!h || h.released) return;
		h.released = true;
		if (h.timer) {
			clearTimeout(h.timer);
			hold.current = null;
			latest.current.onTap?.();
			return;
		}
		stopPump();
	};

	useEffect(
		() => () => {
			const h = hold.current;
			if (!h) return;
			h.released = true;
			if (h.timer) clearTimeout(h.timer);
			h.pump?.();
		},
		[],
	);

	return { phase, heard, holding: () => hold.current !== null, press, release };
}
