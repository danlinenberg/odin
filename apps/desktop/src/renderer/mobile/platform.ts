/**
 * Which phone app runs the screens. The Android app (apps/mobile/android)
 * has only OdinKeychain and OdinScan on its native side: no speech, share
 * sheet, screenshot or lock screen widget, so the screens hide those there.
 */

type Native = {
	getPlatform?: () => string;
	nativePromise?: (
		plugin: string,
		method: string,
	) => Promise<{ text?: string }>;
};
const capacitor = (window as { Capacitor?: Native }).Capacitor;

export const onAndroid = capacitor?.getPlatform?.() === "android";

/**
 * Android: scans the pair QR code in the app (OdinScanPlugin.java), since
 * Android camera apps don't reliably open an odin:// link. The code's text,
 * or null when cancelled.
 */
export async function scanPairCode(): Promise<string | null> {
	const answer = await capacitor?.nativePromise?.("OdinScan", "scan");
	return answer?.text ?? null;
}
