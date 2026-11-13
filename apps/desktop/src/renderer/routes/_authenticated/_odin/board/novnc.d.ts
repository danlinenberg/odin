/** The part of noVNC's RFB client the drawer's View tab uses (noVNC ships no types). */
declare module "@novnc/novnc" {
	interface RfbEvents {
		connect: CustomEvent<Record<string, never>>;
		disconnect: CustomEvent<{ clean: boolean }>;
		desktopname: CustomEvent<{ name: string }>;
		clipboard: CustomEvent<{ text: string }>;
	}
	export default class RFB extends EventTarget {
		constructor(
			target: HTMLElement,
			url: string,
			options?: { credentials?: { password?: string } },
		);
		scaleViewport: boolean;
		qualityLevel: number;
		compressionLevel: number;
		disconnect(): void;
		sendKey(keysym: number, code: string | null, down?: boolean): void;
		clipboardPasteFrom(text: string): void;
		addEventListener<K extends keyof RfbEvents>(
			type: K,
			listener: (event: RfbEvents[K]) => void,
		): void;
		removeEventListener<K extends keyof RfbEvents>(
			type: K,
			listener: (event: RfbEvents[K]) => void,
		): void;
	}
}
