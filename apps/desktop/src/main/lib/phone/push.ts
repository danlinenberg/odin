import { recentlyEnded } from "shared/recently-ended";
import { readPushKey, sendPush } from "./apns";
import { devices, setPush } from "./trust";

/**
 * Keeps the iPhone's lock screen widget current: when the sessions whose turn
 * ended in the last hour change (one ends, or you answer one), each paired
 * phone gets a silent push with their end times - times only, never a title,
 * since the push goes through Apple. The widget counts each one down an hour
 * after it ended by itself, so aging out needs no push.
 */

const CHECK_MS = 15_000;
/** iOS drops silent pushes that come too often; changes inside a minute go out together. */
const MIN_GAP_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let lastSent = "";
let lastAt = 0;

/** The end times the widget counts: what the phone's board would list as recently ended. */
export async function endedTimes(now = Date.now()): Promise<number[]> {
	// Loaded here: the board pulls in Electron, which the phone's tests run without.
	const { loadSessions } = await import("main/lib/tray");
	const { activeProfileId } = await import("lib/trpc/routers/odin-config");
	const sessions = await loadSessions(true, activeProfileId());
	return recentlyEnded(sessions, now).map((s) => s.statusAt);
}

async function check(): Promise<void> {
	const key = readPushKey();
	const phones = devices().filter((d) => d.push);
	if (!key || phones.length === 0) return;
	const ended = await endedTimes();
	const signature = ended.join(",");
	if (signature === lastSent || Date.now() - lastAt < MIN_GAP_MS) return;
	lastSent = signature;
	lastAt = Date.now();
	for (const phone of phones) {
		const target = phone.push;
		if (!target) continue;
		const result = await sendPush(target, { ended }, key).catch((error) => {
			console.warn("[phone-push]", error);
			return null;
		});
		if (result && "gone" in result) setPush(phone.key, null);
		else if (result && target.sandbox === undefined)
			setPush(phone.key, { ...target, sandbox: result.sent === "sandbox" });
	}
}

/** A phone just sent its token: its widget gets the current count on the next check. */
export function pushSoon(): void {
	lastSent = "";
	lastAt = 0;
}

/** Runs while phone access is on. */
export function startPush(): void {
	if (timer) return;
	timer = setInterval(() => void check().catch(() => {}), CHECK_MS);
}

export function stopPush(): void {
	if (timer) clearInterval(timer);
	timer = null;
	lastSent = "";
}
