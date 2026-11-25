import { useState } from "react";
import { isHotkey, useHotkeyDisplay } from "renderer/hotkeys";

/**
 * The Diff tab's Edit: the file as it is on disk, in a plain code box. Save
 * (or the Save file key, Cmd/Ctrl+S) writes it back and the diff reloads; Cancel drops the edit.
 * Tab types a tab instead of leaving the box. Lines never wrap, so the
 * numbers beside them stay true.
 */
export function DiffFileEditor({
	path,
	initial,
	saving,
	error,
	onSave,
	onCancel,
	onDirty,
}: {
	path: string;
	initial: string;
	saving: boolean;
	error: string | null;
	onSave: (content: string) => void;
	onCancel: () => void;
	/** Tells the panel there's an unsaved edit, so switching files can ask. */
	onDirty: (dirty: boolean) => void;
}) {
	const [text, setText] = useState(initial);
	const saveKeys = useHotkeyDisplay("SAVE_FILE").text;
	const dirty = text !== initial;
	const lines = text.split("\n").length;
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-[12px]">
				<span className="min-w-0 truncate text-soft-foreground" title={path}>
					✎ Editing {path}
				</span>
				{dirty && <span className="text-attention">unsaved</span>}
				<span className="ml-auto text-faint-foreground">
					{saveKeys !== "Unassigned" && `${saveKeys} saves`}
				</span>
				<button
					type="button"
					onClick={onCancel}
					className="text-muted-foreground hover:underline"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={() => onSave(text)}
					disabled={!dirty || saving}
					title="Write this file to disk"
					className="rounded bg-primary px-2 py-0.5 text-primary-foreground disabled:opacity-50"
				>
					{saving ? "Saving…" : "Save"}
				</button>
			</div>
			{error && (
				<div className="select-text cursor-text border-b border-border px-4 py-2 text-[12px] text-danger">
					{error}
				</div>
			)}
			<div className="flex min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[20px]">
				<pre
					aria-hidden
					className="sticky left-0 shrink-0 select-none bg-background px-2 py-2 text-right text-faint-foreground"
				>
					{Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
				</pre>
				<textarea
					// biome-ignore lint/a11y/noAutofocus: the box opens because you asked to edit
					autoFocus
					aria-label={`Edit ${path}`}
					spellCheck={false}
					value={text}
					wrap="off"
					onChange={(event) => {
						setText(event.target.value);
						onDirty(event.target.value !== initial);
					}}
					onKeyDown={(event) => {
						if (isHotkey("SAVE_FILE", event.nativeEvent)) {
							event.preventDefault();
							if (dirty && !saving) onSave(text);
						} else if (event.key === "Tab" && !event.shiftKey) {
							event.preventDefault();
							const box = event.currentTarget;
							const { selectionStart: from, selectionEnd: to } = box;
							const next = `${text.slice(0, from)}\t${text.slice(to)}`;
							setText(next);
							onDirty(next !== initial);
							requestAnimationFrame(() =>
								box.setSelectionRange(from + 1, from + 1),
							);
						}
					}}
					style={{ height: `${lines * 20 + 16}px`, tabSize: 4 }}
					className="min-w-0 flex-1 resize-none overflow-x-auto overflow-y-hidden bg-background px-2 py-2 text-soft-foreground outline-none"
				/>
			</div>
		</div>
	);
}
