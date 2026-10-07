import { useState } from "react";
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
	return <Ask key={pending.id} pending={pending} />;
}

/** One big Start; "+ Add context" opens the full prompt box. */
function Ask({ pending }: { pending: Pending }) {
	const [expanded, setExpanded] = useState(false);
	const close = (context: SessionContext | null) => {
		usePending.setState({ pending: null });
		pending.resolve(context);
	};
	const heading = `Start: ${pending.title}`;
	if (expanded)
		return (
			<OdinPromptDialog
				heading={heading}
				note="Context or guidelines for this session. Leave it empty to start as is."
				placeholder="e.g. Only touch the API. Explain in plain words. Don't open a PR."
				onCancel={() => close(null)}
				onSubmit={(guidelines, images) => close({ guidelines, images })}
			/>
		);
	return (
		<>
			<button
				type="button"
				aria-label="Cancel"
				className="fixed inset-0 z-40 cursor-default bg-black/50 bg-none"
				onClick={() => close(null)}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={heading}
				onKeyDown={(event) => {
					if (event.key === "Escape") close(null);
				}}
				className="fixed left-1/2 top-[12vh] z-50 flex w-[460px] max-w-[92vw] -translate-x-1/2 flex-col gap-3 rounded-[10px] border border-border bg-popover p-4 shadow-[0_18px_60px_rgba(0,0,0,0.6)]"
			>
				<div className="text-xs font-semibold text-foreground">{heading}</div>
				<button
					type="button"
					// biome-ignore lint/a11y/noAutofocus: Enter should start - the whole point of the dialog.
					autoFocus
					onClick={() => close({ guidelines: "", images: [] })}
					className="w-full rounded-[8px] bg-primary py-2.5 text-[14px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
				>
					Start session
				</button>
				<button
					type="button"
					onClick={() => setExpanded(true)}
					className="self-center text-[12px] text-muted-foreground transition-colors hover:text-foreground"
				>
					+ Add context or guidelines (optional)
				</button>
			</div>
		</>
	);
}
