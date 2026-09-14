import { settings } from "@odin/local-db";
import { localDb } from "./local-db";
import { playSoundFile } from "./play-sound";
import { getSoundPath } from "./sound-paths";

const NOTIFICATION_SOUND_FILE = "ping.mp3";

/**
 * Plays the notification sound, honouring the mute toggle and volume setting.
 */
export function playNotificationSound(): void {
	let muted = false;
	let volume = 100;

	try {
		const settingsRow = localDb.select().from(settings).get();
		muted = settingsRow?.notificationSoundsMuted ?? false;
		const raw = settingsRow?.notificationVolume;
		volume =
			typeof raw === "number" && Number.isFinite(raw)
				? Math.max(0, Math.min(100, raw))
				: 100;
	} catch (err) {
		console.warn("[notification-sound] Failed to read settings", err);
	}

	if (muted) {
		return;
	}

	playSoundFile(getSoundPath(NOTIFICATION_SOUND_FILE), volume);
}
