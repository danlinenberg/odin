import { create } from "zustand";
import { OdinPromptDialog, type PromptImage } from "./OdinPromptDialog";

export interface SessionContext {
	guidelines: string;
	images: PromptImage[];
}

interface Pending {
	id: number;
	title: string;
	resolve: (context: SessionContext | null) => void;
}

const usePending = create<{ pending: Pending | null }>(() => ({
	pending: null,
}));

let nextId = 0;

/**
 * Ask for optional context before a task's session starts - null when the
 * person cancels. One dialog at a time: a second ask cancels the first.
 */
export function askSessionContext(
	title: string,
): Promise<SessionContext | null> {
	usePending.getState().pending?.resolve(null);
	return new Promise((resolve) =>
		usePending.setState({ pending: { id: nextId++, title, resolve } }),
	);
}

/** Mounted once in the Odin layout; opens whenever `askSessionContext` asks. */
export function SessionContextDialog() {
	const pending = usePending((s) => s.pending);
	if (!pending) return null;
	const close = (context: SessionContext | null) => {
		usePending.setState({ pending: null });
		pending.resolve(context);
	};
	return (
		<OdinPromptDialog
			key={pending.id}
			heading={`Start: ${pending.title}`}
			note="Optional - add context or guidelines for this session. Leave it empty to start as is."
			placeholder="e.g. Only touch the API. Explain in plain words. Don't open a PR."
			onCancel={() => close(null)}
			onSubmit={(guidelines, images) => close({ guidelines, images })}
		/>
	);
}
