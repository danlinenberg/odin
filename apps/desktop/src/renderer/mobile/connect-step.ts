import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * What the app is doing to reach Odin right now, for the board's spinner:
 * which path it tries (the Wi-Fi, the relay), the handshake, or the wait for
 * an answer. A slow first load then says where it is stuck. `since` is when
 * that step began.
 */
export type ConnectStep = { text: string; since: number };

let current: ConnectStep | null = null;
const listeners = new Set<() => void>();

/** Sets the step; null once an answer came back. The same text keeps its start. */
export function setConnectStep(text: string | null, now = Date.now()): void {
	if ((current?.text ?? null) === text) return;
	current = text ? { text, since: now } : null;
	for (const listener of listeners) listener();
}

export const connectStep = (): ConnectStep | null => current;

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The step, with the seconds it has taken so far: "Reaching your Mac through the relay - 12s". */
export function useConnectStep(): string | null {
	const step = useSyncExternalStore(subscribe, connectStep);
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!step) return;
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [step]);
	if (!step) return null;
	const seconds = Math.max(0, Math.floor((now - step.since) / 1_000));
	return seconds >= 1 ? `${step.text} - ${seconds}s` : step.text;
}
