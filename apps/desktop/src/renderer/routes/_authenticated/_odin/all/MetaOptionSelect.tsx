import { type ReactNode, useMemo, useRef, useState } from "react";
import {
	isCustomOption,
	type MetaKind,
	type MetaOption,
	statusOptions,
	typeOptions,
	useTaskMeta,
} from "./task-meta";

/** The Status or Type dropdown's choices, built-in and yours, kept current. */
export function useMetaOptions(kind: MetaKind): MetaOption[] {
	const custom = useTaskMeta((s) =>
		kind === "status" ? s.customStatuses : s.customTypes,
	);
	return useMemo(
		() => (kind === "status" ? statusOptions(custom) : typeOptions(custom)),
		[kind, custom],
	);
}

const ADD = "__odin-add__";
const REMOVE = "__odin-remove__";

/**
 * A Status or Type dropdown you can add your own values to: "+ Add type..."
 * turns it into a box for the name (Enter adds it and picks it, Esc cancels),
 * and with one of yours picked, "Remove ... from the list" takes it off.
 * `select` draws the caller's own select around the options.
 */
export function MetaOptionSelect({
	kind,
	value,
	onChange,
	empty,
	inputClassName,
	select,
}: {
	kind: MetaKind;
	value: string;
	onChange: (value: string) => void;
	/** The first option, the no-value one ("No type", "Waiting on you"). */
	empty: ReactNode;
	inputClassName: string;
	select: (
		value: string,
		onChange: (value: string) => void,
		options: ReactNode,
	) => ReactNode;
}) {
	const options = useMetaOptions(kind);
	const addCustomOption = useTaskMeta((s) => s.addCustomOption);
	const removeCustomOption = useTaskMeta((s) => s.removeCustomOption);
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState("");
	// Enter or Esc closes the box; the blur that can follow must not add it again.
	const closed = useRef(false);
	const noun = kind === "status" ? "status" : "type";
	const current = options.find((o) => o.id === value);

	if (adding) {
		const finish = (save: boolean) => {
			if (closed.current) return;
			closed.current = true;
			setAdding(false);
			setDraft("");
			if (!save) return;
			const id = addCustomOption(kind, draft);
			// Already in the list: pick that one instead.
			const existing = options.find(
				(o) => o.label.toLowerCase() === draft.trim().toLowerCase(),
			);
			const pick = id ?? existing?.id;
			if (pick) onChange(pick);
		};
		return (
			<input
				// biome-ignore lint/a11y/noAutofocus: the box only appears when you ask for it
				autoFocus
				aria-label={`New ${noun}`}
				placeholder={`New ${noun}, Enter to add`}
				value={draft}
				maxLength={40}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					// Kept here: Enter must not send the task box, Esc must not close its dialog.
					if (event.key !== "Enter" && event.key !== "Escape") return;
					event.preventDefault();
					event.stopPropagation();
					finish(event.key === "Enter");
				}}
				onBlur={() => finish(draft.trim() !== "")}
				className={inputClassName}
			/>
		);
	}

	const pick = (next: string) => {
		if (next === ADD) {
			closed.current = false;
			return setAdding(true);
		}
		if (next === REMOVE) {
			removeCustomOption(kind, value);
			return onChange("");
		}
		onChange(next);
	};
	return select(
		value,
		pick,
		<>
			{empty}
			{options.map(({ id, label }) => (
				<option key={id} value={id}>
					{label}
				</option>
			))}
			<option value={ADD}>+ Add {noun}...</option>
			{current && isCustomOption(current.id) && (
				<option value={REMOVE}>Remove "{current.label}" from the list</option>
			)}
		</>,
	);
}
