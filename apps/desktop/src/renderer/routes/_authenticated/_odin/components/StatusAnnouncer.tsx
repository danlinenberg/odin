import { useEffect, useRef, useState } from "react";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane, PaneStatus } from "shared/tabs-types";
import { PANE_STATUS } from "../pane-status";

// Working flips on every tool call; announcing it would drown the reader.
const ANNOUNCED: ReadonlySet<PaneStatus> = new Set([
	"permission",
	"review",
	"failed",
]);

/** The lines to announce for panes whose status just moved into ANNOUNCED. */
export function statusAnnouncements(
	prev: Map<string, PaneStatus | undefined>,
	panes: Record<string, Pane>,
): string[] {
	const lines: string[] = [];
	for (const pane of Object.values(panes)) {
		const status = pane.status;
		if (!prev.has(pane.id) || prev.get(pane.id) === status) continue;
		if (status && ANNOUNCED.has(status)) {
			lines.push(
				`${pane.userTitle || pane.name}: ${PANE_STATUS[status].label}`,
			);
		}
	}
	return lines;
}

/**
 * A screen reader hears a session move to Needs you, Final Review or Failed:
 * the board shows it only as a coloured dot, which a reader never reaches
 * unless it happens to be on that card.
 */
export function StatusAnnouncer() {
	const [message, setMessage] = useState("");
	const prev = useRef<Map<string, PaneStatus | undefined> | null>(null);

	useEffect(() => {
		const snapshot = (panes: Record<string, Pane>) =>
			new Map(Object.values(panes).map((p) => [p.id, p.status]));
		prev.current = snapshot(useTabsStore.getState().panes);
		return useTabsStore.subscribe((state) => {
			const before = prev.current;
			prev.current = snapshot(state.panes);
			if (!before) return;
			const lines = statusAnnouncements(before, state.panes);
			if (lines.length) setMessage(lines.join(". "));
		});
	}, []);

	return (
		<output aria-live="polite" className="sr-only">
			{message}
		</output>
	);
}
