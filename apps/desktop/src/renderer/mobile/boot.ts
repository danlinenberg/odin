import { NATIVE_API } from "./native-api";
import { storeDelete, storeGet, storeSet } from "./screens-store";

/**
 * The app's first code, and the only part of the screens an update can't
 * replace: it runs the screens Odin last sent this phone (screens-update.ts)
 * when they suit this app's native side, else the ones built into the app.
 *
 * A launch marks the version it tries, and the screens clear the mark once
 * they draw (markStarted). A mark still there at the next launch means they
 * never drew: that version is set aside and the built-in screens run, so a
 * broken update can't lock you out of the app.
 */

declare global {
	interface Window {
		/** The version of Odin's screens running now; unset for the built-in ones. */
		__odinScreens?: string;
	}
}

const inApp = () =>
	!!(
		window as { Capacitor?: { isNativePlatform?: () => boolean } }
	).Capacitor?.isNativePlatform?.() &&
	// A dev page (`?t=`, sim.sh --live) runs the code it was served.
	!new URLSearchParams(location.search).has("t");

async function sentScreens(): Promise<boolean> {
	const [bundle, trying, bad] = await Promise.all([
		storeGet("bundle"),
		storeGet("trying"),
		storeGet("bad"),
	]);
	let skip = bad;
	if (trying) {
		await storeSet("bad", trying);
		await storeDelete("trying");
		skip = trying;
	}
	if (!bundle || bundle.native !== NATIVE_API || bundle.version === skip)
		return false;
	await storeSet("trying", bundle.version);
	window.__odinScreens = bundle.version;
	const style = document.createElement("style");
	style.textContent = bundle.css;
	document.head.append(style);
	const script = document.createElement("script");
	script.type = "module";
	script.src = URL.createObjectURL(
		new Blob([bundle.js], { type: "text/javascript" }),
	);
	document.body.append(script);
	return true;
}

void (async () => {
	try {
		if (inApp() && (await sentScreens())) return;
	} catch {
		// No IndexedDB, or a store that won't open: the built-in screens.
	}
	window.__odinScreens = undefined;
	await import("./main");
})();
