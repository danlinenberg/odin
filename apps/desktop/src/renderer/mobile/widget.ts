import type { OdinFetch } from "./odin-fetch";

/**
 * The lock screen widget (apps/mobile/ios/App/OdinWidget): the app hands it
 * the end times of the sessions that ended in the last hour each time the
 * board loads, and sends Odin this phone's push token, so Odin can update
 * it with the phone locked (main/lib/phone/push.ts). Both are no-ops in a
 * browser and on an app built before the widget.
 */

type Native = {
	nativePromise?: (
		plugin: string,
		method: string,
		options?: object,
	) => Promise<{ token?: string; topic?: string }>;
};
const native = () =>
	(window as { Capacitor?: Native }).Capacitor?.nativePromise;

let lastEnded = "";

/** The widget's count, from the board in hand. */
export function updateWidget(ended: number[]): void {
	const signature = ended.join(",");
	if (signature === lastEnded) return;
	lastEnded = signature;
	void native()?.("OdinWidget", "update", { ended })?.catch(() => {});
}

let registered = false;

/** Once a launch: this phone's APNs token to Odin, over the encrypted channel. */
export async function registerPush(odinFetch: OdinFetch): Promise<void> {
	const call = native();
	if (registered || !call) return;
	registered = true;
	try {
		const { token, topic } = await call("OdinWidget", "pushToken");
		if (!token || !topic) return;
		await odinFetch("/push-token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, topic }),
		});
	} catch {
		// No push on this phone (or this Odin): the widget updates when the app opens.
	}
}
