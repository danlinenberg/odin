/**
 * The board's answer to a reply from the phone (main/lib/phone/router.ts):
 * a session Claude has exited resumes with the reply as its opening message,
 * as the desktop's chat box does; a running one gets it typed in. The board
 * page sets the handler while it's mounted.
 */
export type PhoneReply = (paneId: string, text: string) => "resumed" | "live";

let handler: PhoneReply | null = null;

export const setPhoneReply = (next: PhoneReply | null) => {
	handler = next;
};

/** "live" when no board is mounted to resume it: then it's typed in. */
export const phoneReply = (paneId: string, text: string) =>
	handler?.(paneId, text) ?? "live";
