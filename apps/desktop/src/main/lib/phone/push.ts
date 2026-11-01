import { recentlyEnded } from "shared/recently-ended";
import { devices, type PushTarget, setPush } from "./trust";

/**
 * Keeps the iPhone's lock screen widget current: when the sessions whose turn
 * ended in the last hour change (one ends, or you answer one), each paired
 * phone gets a silent push with their end times - times only, never a title,
 * since the push goes through Apple. Odin's relay signs it with the App Store
 * app's APNs key (packages/odin-relay/src/push.ts), so nobody sets up a key.
 * The widget counts each one down an hour after it ended by itself, so aging
 * out needs no push.
 */

/**
 * Always Odin's own relay, also for someone who runs their own for the
 * channel: only it holds the app's APNs key. A test points it elsewhere.
 */
export const pushRelay = { url: "https://3-76-62-130.sslip.io/push" };

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

/**
 * One push through the relay. `sent` names the APNs that took it (an Xcode
 * build's token is the sandbox's); `gone`: the app was deleted.
 */
export async function sendPush(
	target: PushTarget,
	ended: number[],
): Promise<{ sent: "production" | "sandbox" } | { gone: true } | null> {
	const answer = await fetch(pushRelay.url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			token: target.token,
			ended,
			sandbox: target.sandbox,
		}),
		signal: AbortSignal.timeout(20_000),
	});
	if (answer.status === 410) return { gone: true };
	if (!answer.ok) {
		console.warn(`[phone-push] relay answered ${answer.status}`);
		return null;
	}
	const { sent } = (await answer.json()) as { sent?: string };
	return sent === "sandbox" || sent === "production" ? { sent } : null;
}

async function check(): Promise<void> {
	const phones = devices().filter((d) => d.push);
	if (phones.length === 0) return;
	const ended = await endedTimes();
	const signature = ended.join(",");
	if (signature === lastSent || Date.now() - lastAt < MIN_GAP_MS) return;
	lastSent = signature;
	lastAt = Date.now();
	for (const phone of phones) {
		const target = phone.push;
		if (!target) continue;
		const result = await sendPush(target, ended).catch((error) => {
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
