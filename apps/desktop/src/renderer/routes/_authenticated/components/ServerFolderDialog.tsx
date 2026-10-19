import { useState } from "react";
import { create } from "zustand";

interface Pending {
	id: number;
	current: string | null;
	resolve: (path: string | null) => void;
}

const usePending = create<{ pending: Pending | null }>(() => ({
	pending: null,
}));

let nextId = 0;

/**
 * Ask for a folder on the remote server - where its sessions start. No file
 * picker can show the server's disk, and Electron has no window.prompt, so
 * this is a small dialog of its own. Null when the person cancels; a second
 * ask cancels the first.
 */
export function askServerFolder(
	current: string | null = null,
): Promise<string | null> {
	usePending.getState().pending?.resolve(null);
	return new Promise((resolve) =>
		usePending.setState({ pending: { id: nextId++, current, resolve } }),
	);
}

/** Mounted once for every signed-in screen; opens whenever `askServerFolder` asks. */
export function ServerFolderDialog() {
	const pending = usePending((s) => s.pending);
	if (!pending) return null;
	return <Ask key={pending.id} pending={pending} />;
}

function Ask({ pending }: { pending: Pending }) {
	const [path, setPath] = useState(pending.current ?? "");
	const close = (value: string | null) => {
		usePending.setState({ pending: null });
		pending.resolve(value);
	};
	const valid = path.trim().startsWith("/");
	return (
		<>
			<button
				type="button"
				aria-label="Cancel"
				className="fixed inset-0 z-40 cursor-default bg-black/50 bg-none"
				onClick={() => close(null)}
			/>
			<form
				role="dialog"
				aria-modal="true"
				aria-label="Folder on the server"
				onKeyDown={(event) => {
					if (event.key === "Escape") close(null);
				}}
				onSubmit={(event) => {
					event.preventDefault();
					if (valid) close(path.trim());
				}}
				className="fixed left-1/2 top-[12vh] z-50 flex w-[480px] max-w-[92vw] -translate-x-1/2 flex-col gap-3 rounded-[10px] border border-border bg-popover p-4 shadow-[0_18px_60px_rgba(0,0,0,0.6)]"
			>
				<div className="text-xs font-semibold text-foreground">
					Folder on the server
				</div>
				<div className="text-xs text-muted-foreground">
					Sessions run on your remote server. Which folder there should they
					start in? Usually the one your repos live in, as an absolute path.
				</div>
				<input
					// biome-ignore lint/a11y/noAutofocus: the dialog is only this field.
					autoFocus
					value={path}
					onChange={(event) => setPath(event.target.value)}
					placeholder="/home/me/repo"
					spellCheck={false}
					className="rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary"
				/>
				<div className="flex justify-end gap-2">
					<button
						type="button"
						onClick={() => close(null)}
						className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={!valid}
						className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
					>
						Use this folder
					</button>
				</div>
			</form>
		</>
	);
}
