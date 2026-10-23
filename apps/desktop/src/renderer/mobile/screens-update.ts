import { useEffect, useState } from "react";
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

/**
 * Asks Odin for newer screens - at launch, now and then, and on coming back
 * to the app - and keeps them for the next launch (boot.ts). True once some
 * are waiting: a reload runs them.
 */
export function useScreensUpdate(
	check: (input: {
		have: string;
		native: number;
	}) => Promise<ScreensBundle | null>,
	enabled: boolean,
): boolean {
	const [ready, setReady] = useState(false);
	useEffect(() => {
		if (!enabled) return;
		let gone = false;
		const run = async () => {
			try {
				const sent = await check({
					have: window.__odinScreens ?? "built-in",
					native: NATIVE_API,
				});
				if (!sent || gone) return;
				if ((await storeGet("bundle"))?.version !== sent.version)
					await storeSet("bundle", sent);
				if (!gone) setReady(true);
			} catch {
				// Odin unreachable, or an older Odin without screens: next time.
			}
		};
		void run();
		const timer = setInterval(run, CHECK_MS);
		const onShow = () => {
			if (document.visibilityState === "visible") void run();
		};
		document.addEventListener("visibilitychange", onShow);
		return () => {
			gone = true;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onShow);
		};
	}, [check, enabled]);
	return ready;
}
