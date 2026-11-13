import { useEffect } from "react";
import { NATIVE_API } from "./native-api";
import {
	type ScreensBundle,
	storeDelete,
	storeGet,
	storeSet,
} from "./screens-store";

/** How often a phone left open asks Odin for newer screens. */
const CHECK_MS = 15 * 60_000;

/** The screens Odin sent drew: boot.ts keeps running them. */
export function markStarted() {
	if (window.__odinScreens) void storeDelete("trying").catch(() => {});
}

/** How many screens hold something a reload would lose (useUnsaved). */
let unsaved = 0;

/** While `on`, the screens are not reloaded for an update: something typed, attached or being sent would be lost. */
export function useUnsaved(on: boolean) {
	useEffect(() => {
		if (!on) return;
		unsaved++;
		return () => {
			unsaved--;
		};
	}, [on]);
}

/** The version this launch already reloaded for (sessionStorage). */
const RELOADED_KEY = "odin-screens-reloaded";

/**
 * Whether to reload into the screens just stored. Not while something unsent
 * is on screen, not for a version boot.ts set aside as broken, and once per
 * version in a launch, so a version that won't run can't reload forever.
 */
export const shouldReload = (
	version: string,
	state: { unsaved: boolean; bad?: string; reloaded?: string | null },
) => !state.unsaved && version !== state.bad && version !== state.reloaded;

/**
 * Asks Odin for newer screens - at launch, now and then, and on coming back
 * to the app - keeps them (boot.ts), and reloads into them by itself. With
 * something unsent on screen the reload waits for the next check, or for the
 * app to go to the background or come back.
 */
export function useScreensUpdate(
	check: (input: {
		have: string;
		native: number;
	}) => Promise<ScreensBundle | null>,
	enabled: boolean,
	/** Something unsent that no screen shows now, like a draft in a session you left. */
	holds: () => boolean,
): void {
	useEffect(() => {
		if (!enabled) return;
		let gone = false;
		let waiting: string | undefined;
		const apply = async () => {
			if (!waiting) return;
			const bad = await storeGet("bad").catch(() => undefined);
			const state = {
				unsaved: unsaved > 0 || holds(),
				bad,
				reloaded: sessionStorage.getItem(RELOADED_KEY),
			};
			if (gone || !shouldReload(waiting, state)) return;
			sessionStorage.setItem(RELOADED_KEY, waiting);
			location.reload();
		};
		const run = async () => {
			try {
				const sent = await check({
					have: window.__odinScreens ?? "built-in",
					native: NATIVE_API,
				});
				if (!sent || gone) return;
				if ((await storeGet("bundle"))?.version !== sent.version)
					await storeSet("bundle", sent);
				waiting = sent.version;
				await apply();
			} catch {
				// Odin unreachable, or an older Odin without screens: next time.
			}
		};
		void run();
		const timer = setInterval(run, CHECK_MS);
		const onShow = () => {
			if (document.visibilityState === "visible") void run();
			else void apply();
		};
		document.addEventListener("visibilitychange", onShow);
		return () => {
			gone = true;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onShow);
		};
	}, [check, enabled, holds]);
}
