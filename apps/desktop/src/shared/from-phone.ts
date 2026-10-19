/**
 * Whether a message in a session's transcript is one the Odin iPhone app sent
 * (main/lib/phone/sent.ts keeps those texts). Files are pasted before the
 * text, so the message ends with it.
 */
export const cameFromPhone = (message: string, sent: string[]): boolean =>
	sent.some((text) => message.trim().endsWith(text));
