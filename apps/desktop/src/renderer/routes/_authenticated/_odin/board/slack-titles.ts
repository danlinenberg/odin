import { useCallback, useEffect, useMemo } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane } from "renderer/stores/tabs/types";
import { create } from "zustand";

/** Slack's raw markup: `<@U123>`, `<#C123>`, `<!here>`. */
const RAW_SLACK = /<[@#!][A-Za-z0-9]/;

/** Card titles still in Slack's raw markup, keyed by pane id. */
export function rawSlackTitles(
	panes: Record<string, Pick<Pane, "odinTaskTitle">>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [id, pane] of Object.entries(panes))
		if (pane.odinTaskTitle && RAW_SLACK.test(pane.odinTaskTitle))
			out[id] = pane.odinTaskTitle;
	return out;
}

/**
 * A card titled from a Slack message as Slack sent it reads `<@U0B16MXKZRT>
 * Users who...`: the title is rewritten once with the person's name. Only a
 * title still holding that raw text changes, so a rename you typed stays.
 */
export function useReadableSlackTitles(): void {
	const raw = useTabsStore((s) => JSON.stringify(rawSlackTitles(s.panes)));
	const titles = useMemo(
		() => JSON.parse(raw) as Record<string, string>,
		[raw],
	);
	useEffect(() => {
		const ids = Object.keys(titles);
		if (ids.length === 0) return;
		void electronTrpcClient.slack.readable
			.mutate({ texts: ids.map((id) => titles[id]) })
			.then((readable) =>
				useTabsStore.setState((state) => {
					const panes = { ...state.panes };
					let changed = false;
					ids.forEach((id, i) => {
						const pane = panes[id];
						const next = readable[i];
						if (!pane || pane.odinTaskTitle !== titles[id]) return;
						if (!next || next === titles[id]) return;
						panes[id] = { ...pane, odinTaskTitle: next };
						changed = true;
					});
					return changed ? { panes } : state;
				}),
			)
			.catch(() => {});
	}, [titles]);
}

/** Raw Slack text to its readable form, once each has come back. */
const useReadableText = create<{ byRaw: Record<string, string> }>(() => ({
	byRaw: {},
}));
const asked = new Set<string>();
let pending: string[] = [];

function ask(raw: string): void {
	if (asked.has(raw)) return;
	asked.add(raw);
	pending.push(raw);
	if (pending.length > 1) return;
	queueMicrotask(() => {
		const texts = pending;
		pending = [];
		void electronTrpcClient.slack.readable
			.mutate({ texts })
			.then((readable) =>
				useReadableText.setState((state) => {
					const byRaw = { ...state.byRaw };
					texts.forEach((text, i) => {
						byRaw[text] = readable[i] || text;
					});
					return { byRaw };
				}),
			)
			// Asked again on a later render.
			.catch(() => {
				for (const text of texts) asked.delete(text);
			});
	});
}

/**
 * A title shown in Slack's raw markup, wherever it came from (the launch
 * title, an auto-rename, the Slack message a cut title is filled back from):
 * `<@U0B16MXKZRT> Users who...` reads `@Name Users who...`. The raw text shows
 * until the names come back.
 */
export function useSlackReadable(): (text: string) => string {
	const byRaw = useReadableText((s) => s.byRaw);
	return useCallback(
		(text: string) => {
			if (!RAW_SLACK.test(text)) return text;
			const readable = byRaw[text];
			if (readable === undefined) ask(text);
			return readable ?? text;
		},
		[byRaw],
	);
}
